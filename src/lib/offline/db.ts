/**
 * IndexedDB layer for the offline-first POS (via `idb`).
 *
 * Stores:
 *  - products   cached POS catalog (key: _id, indexes: barcode, sku, name)
 *  - categories cached category list (key: _id)
 *  - customers  cached customers for the picker (key: _id, index: name)
 *  - meta       key/value (store info, lastSyncAt, last catalogue sync, …)
 *  - queue      offline sales awaiting sync (key: clientTransactionId,
 *               indexes: status, nextAttemptAt, createdAt)
 *  - localSales offline receipt history persisted on this device
 *  - conflicts  stock/data conflicts detected during sync (key: id)
 *
 * NO CREDENTIALS ARE EVER STORED HERE — see the offline auth note in the
 * final summary. The session lives in httpOnly cookies only.
 */

import { openDB, type IDBPDatabase } from "idb";
import type { QueueStatus } from "./backoff";

const DB_NAME = "pos-offline";
const DB_VERSION = 1;

export interface CachedProduct {
  _id: string;
  name: string;
  sku: string;
  barcode: string;
  sellingPrice: number;
  discountPrice: number;
  taxRate: number;
  /** Cached stock at last sync; local offline sales reduce the effective stock. */
  currentStock: number;
  categoryId?: { _id: string; name: string } | null;
}

export interface CachedCustomer {
  _id: string;
  name: string;
  phone: string;
  balance: number;
}

/** Body of POST /api/sales / /api/sync/sale — stored verbatim in the queue. */
export interface OfflineSalePayload {
  customerId: string | null;
  items: Array<{ productId: string; quantity: number; unitDiscount: number }>;
  discount: number;
  discountType: "amount" | "percent";
  payments: Array<{ method: "cash" | "card" | "transfer" | "credit"; amount: number; reference: string }>;
  note: string;
  status: "completed" | "held";
  deviceId?: string;
}

export interface QueuedSale {
  clientTransactionId: string;
  status: QueueStatus;
  /** epoch ms — when the sale was taken offline. */
  createdAt: number;
  /** epoch ms — earliest time the next sync attempt is allowed. */
  nextAttemptAt: number;
  attempts: number;
  lastError: string | null;
  /** OFFLINE-YYYYMMDD-NNNNNN shown to the customer until sync. */
  offlineRef: string;
  payload: OfflineSalePayload;
  /** Sale total captured client-side at enqueue time (display only). */
  total: number;
  itemCount: number;
  /** Server invoice number once synced (null until then). */
  syncedInvoiceNumber: string | null;
  syncedAt: number | null;
}

/** Local receipt history row — same record as the queue entry. */
export type LocalSaleRecord = QueuedSale;

export interface SyncConflict {
  id: string;
  clientTransactionId: string | null;
  kind: "STOCK_CONFLICT" | "VALIDATION" | "REJECTED";
  productId: string | null;
  message: string;
  createdAt: number;
  resolved: boolean;
}

interface PosOfflineDB {
  products: {
    key: string;
    value: CachedProduct;
    indexes: { barcode: string; sku: string; name: string };
  };
  categories: { key: string; value: { _id: string; name: string } };
  customers: { key: string; value: CachedCustomer; indexes: { name: string } };
  meta: { key: string; value: { key: string; value: unknown } };
  queue: {
    key: string;
    value: QueuedSale;
    indexes: { status: QueueStatus; nextAttemptAt: number; createdAt: number };
  };
  localSales: { key: string; value: LocalSaleRecord; indexes: { createdAt: number } };
  conflicts: { key: string; value: SyncConflict; indexes: { createdAt: number } };
}

let dbPromise: Promise<IDBPDatabase<PosOfflineDB>> | null = null;
let unavailableLogged = false;

/** True when this environment supports IndexedDB (false in tests/SSR). */
export function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

export function getDB(): Promise<IDBPDatabase<PosOfflineDB>> {
  if (!hasIndexedDb()) {
    return Promise.reject(new Error("IndexedDB unavailable in this environment"));
  }
  if (!dbPromise) {
    dbPromise = openDB<PosOfflineDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("products")) {
          const store = db.createObjectStore("products", { keyPath: "_id" });
          store.createIndex("barcode", "barcode", { unique: false });
          store.createIndex("sku", "sku", { unique: false });
          store.createIndex("name", "name", { unique: false });
        }
        if (!db.objectStoreNames.contains("categories")) {
          db.createObjectStore("categories", { keyPath: "_id" });
        }
        if (!db.objectStoreNames.contains("customers")) {
          const store = db.createObjectStore("customers", { keyPath: "_id" });
          store.createIndex("name", "name", { unique: false });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("queue")) {
          const store = db.createObjectStore("queue", { keyPath: "clientTransactionId" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("nextAttemptAt", "nextAttemptAt", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("localSales")) {
          const store = db.createObjectStore("localSales", { keyPath: "clientTransactionId" });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("conflicts")) {
          const store = db.createObjectStore("conflicts", { keyPath: "id" });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      },
    });
    dbPromise.catch(() => {
      // Allow a later call to retry opening (e.g. browser storage pressure).
      dbPromise = null;
      if (!unavailableLogged) {
        unavailableLogged = true;
        console.warn("[offline] IndexedDB unavailable — offline features disabled");
      }
    });
  }
  return dbPromise;
}

/* ----------------------------- meta (kv) ------------------------------ */

export async function getMeta<T>(key: string): Promise<T | null> {
  try {
    const db = await getDB();
    const row = await db.get("meta", key);
    return row ? (row.value as T) : null;
  } catch {
    return null;
  }
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  try {
    const db = await getDB();
    await db.put("meta", { key, value });
  } catch {
    // non-fatal
  }
}

/* ---------------------------- catalog cache ---------------------------- */

export async function cacheCatalog(
  products: CachedProduct[],
  categories: Array<{ _id: string; name: string }>
): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(["products", "categories"], "readwrite");
    await tx.objectStore("products").clear();
    await tx.objectStore("categories").clear();
    await Promise.all([
      ...products.map((p) => tx.objectStore("products").put(p)),
      ...categories.map((c) => tx.objectStore("categories").put(c)),
      tx.done,
    ]);
  } catch {
    // non-fatal
  }
}

export async function getCachedProducts(): Promise<CachedProduct[]> {
  try {
    const db = await getDB();
    return await db.getAll("products");
  } catch {
    return [];
  }
}

export async function getCachedCategories(): Promise<Array<{ _id: string; name: string }>> {
  try {
    const db = await getDB();
    return await db.getAll("categories");
  } catch {
    return [];
  }
}

export async function findCachedProductByBarcode(barcode: string): Promise<CachedProduct | null> {
  try {
    const db = await getDB();
    const exact = await db.getFromIndex("products", "barcode", barcode);
    if (exact) return exact;
    const all = await db.getAll("products");
    const term = barcode.trim().toLowerCase();
    return all.find((p) => p.barcode === barcode || p.sku.toLowerCase() === term) ?? null;
  } catch {
    return null;
  }
}

/** Merges products from a partial (search/page) response into the cache. */
export async function upsertCachedProducts(products: CachedProduct[]): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction("products", "readwrite");
    await Promise.all([...products.map((p) => tx.store.put(p)), tx.done]);
  } catch {
    // non-fatal
  }
}

/** Replaces the cached category list (small, always returned in full). */
export async function putCategories(categories: Array<{ _id: string; name: string }>): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction("categories", "readwrite");
    await tx.store.clear();
    await Promise.all([...categories.map((c) => tx.store.put(c)), tx.done]);
  } catch {
    // non-fatal
  }
}

export async function cacheCustomers(customers: CachedCustomer[]): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction("customers", "readwrite");
    await tx.store.clear();
    await Promise.all([...customers.map((c) => tx.store.put(c)), tx.done]);
  } catch {
    // non-fatal
  }
}

/** Merges customers seen in search results into the cache. */
export async function upsertCachedCustomers(customers: CachedCustomer[]): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction("customers", "readwrite");
    await Promise.all([...customers.map((c) => tx.store.put(c)), tx.done]);
  } catch {
    // non-fatal
  }
}

export async function getCachedCustomers(): Promise<CachedCustomer[]> {
  try {
    const db = await getDB();
    return await db.getAll("customers");
  } catch {
    return [];
  }
}

/* ------------------------- offline sale queue -------------------------- */

/** Offline sales reduce available stock locally. Returns productId → qty sold offline (pending). */
export async function getOfflineSoldQuantities(): Promise<Map<string, number>> {
  const sold = new Map<string, number>();
  try {
    const db = await getDB();
    const entries = await db.getAllFromIndex("queue", "status", "PENDING");
    const syncing = await db.getAllFromIndex("queue", "status", "SYNCING");
    for (const entry of [...entries, ...syncing]) {
      if (entry.payload.status !== "completed") continue;
      for (const item of entry.payload.items) {
        sold.set(item.productId, (sold.get(item.productId) ?? 0) + item.quantity);
      }
    }
  } catch {
    // ignore — behave as if no offline sales
  }
  return sold;
}

export async function enqueueSale(entry: QueuedSale): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["queue", "localSales"], "readwrite");
  await tx.objectStore("queue").put(entry);
  await tx.objectStore("localSales").put(entry);
  await tx.done;
}

export async function getQueuedSale(clientTransactionId: string): Promise<QueuedSale | null> {
  try {
    const db = await getDB();
    return (await db.get("queue", clientTransactionId)) ?? null;
  } catch {
    return null;
  }
}

export async function listQueue(): Promise<QueuedSale[]> {
  try {
    const db = await getDB();
    const rows = await db.getAll("queue");
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export async function listPendingQueue(): Promise<QueuedSale[]> {
  try {
    const db = await getDB();
    const pending = await db.getAllFromIndex("queue", "status", "PENDING");
    const failed = await db.getAllFromIndex("queue", "status", "FAILED");
    const syncing = await db.getAllFromIndex("queue", "status", "SYNCING");
    return [...pending, ...failed, ...syncing].sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export async function countUnsynced(): Promise<number> {
  try {
    const db = await getDB();
    const pending = await db.countFromIndex("queue", "status", "PENDING");
    const failed = await db.countFromIndex("queue", "status", "FAILED");
    const syncing = await db.countFromIndex("queue", "status", "SYNCING");
    return pending + failed + syncing;
  } catch {
    return 0;
  }
}

export async function updateQueuedSale(entry: QueuedSale): Promise<void> {
  try {
    const db = await getDB();
    await db.put("queue", entry);
    // Mirror into local history so the receipt history shows final state.
    const existing = await db.get("localSales", entry.clientTransactionId);
    if (existing) {
      await db.put("localSales", { ...existing, ...entry });
    }
  } catch {
    // non-fatal
  }
}

export async function markSynced(
  clientTransactionId: string,
  invoiceNumber: string | null
): Promise<void> {
  const entry = await getQueuedSale(clientTransactionId);
  if (!entry) return;
  await updateQueuedSale({
    ...entry,
    status: "SYNCED",
    syncedInvoiceNumber: invoiceNumber,
    syncedAt: Date.now(),
    lastError: null,
  });
}

export async function listLocalSales(): Promise<LocalSaleRecord[]> {
  try {
    const db = await getDB();
    const rows = await db.getAll("localSales");
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/* ------------------------------ conflicts ------------------------------ */

export async function addConflict(conflict: SyncConflict): Promise<void> {
  try {
    const db = await getDB();
    await db.put("conflicts", conflict);
  } catch {
    // non-fatal
  }
}

export async function listConflicts(includeResolved = false): Promise<SyncConflict[]> {
  try {
    const db = await getDB();
    const rows = await db.getAll("conflicts");
    return rows
      .filter((c) => includeResolved || !c.resolved)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function resolveConflict(id: string): Promise<void> {
  try {
    const db = await getDB();
    const row = await db.get("conflicts", id);
    if (row) await db.put("conflicts", { ...row, resolved: true });
  } catch {
    // non-fatal
  }
}

/** Test helper: close and delete the database. */
export async function resetOfflineDb(): Promise<void> {
  if (!hasIndexedDb()) return;
  if (dbPromise) {
    try {
      (await dbPromise).close();
    } catch {
      // ignore
    }
    dbPromise = null;
  }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
