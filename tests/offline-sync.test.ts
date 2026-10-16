import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  BACKOFF_SCHEDULE_MS,
  backoffDelayMs,
  isDue,
  nextAttemptAt,
  offlineReference,
  newClientTransactionId,
} from "../src/lib/offline/backoff";
import {
  addConflict,
  cacheCatalog,
  countUnsynced,
  enqueueSale,
  findCachedProductByBarcode,
  getCachedCategories,
  getCachedCustomers,
  getCachedProducts,
  getOfflineSoldQuantities,
  getQueuedSale,
  listConflicts,
  listLocalSales,
  listPendingQueue,
  markSynced,
  resetOfflineDb,
  resolveConflict,
  setMeta,
  getMeta,
  upsertCachedCustomers,
  upsertCachedProducts,
  type QueuedSale,
} from "../src/lib/offline/db";
import { syncNow, retryEntry } from "../src/lib/offline/sync-engine";
import { setConnectionStatus } from "../src/lib/offline/connectivity";

/* ------------------------------------------------------------------ */

function queuedSale(over: Partial<QueuedSale> = {}): QueuedSale {
  return {
    clientTransactionId: newClientTransactionId(),
    status: "PENDING",
    createdAt: Date.now(),
    nextAttemptAt: Date.now(),
    attempts: 0,
    lastError: null,
    offlineRef: offlineReference(),
    total: 100,
    itemCount: 2,
    syncedInvoiceNumber: null,
    syncedAt: null,
    payload: {
      customerId: null,
      items: [{ productId: "p1", quantity: 2, unitDiscount: 0 }],
      discount: 0,
      discountType: "amount",
      payments: [{ method: "cash", amount: 100, reference: "" }],
      note: "",
      status: "completed",
      deviceId: "device-1",
    },
    ...over,
  };
}

const fetchMock = vi.fn();

beforeEach(async () => {
  await resetOfflineDb();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setConnectionStatus("ONLINE");
});

afterEach(async () => {
  await resetOfflineDb();
  vi.unstubAllGlobals();
});

/* ----------------------------- backoff ------------------------------ */

describe("backoff schedule", () => {
  it("follows the 30s → 60s → 2m → 5m schedule and caps at 5m", () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(backoffDelayMs(1)).toBe(30_000);
    expect(backoffDelayMs(2)).toBe(60_000);
    expect(backoffDelayMs(3)).toBe(120_000);
    expect(backoffDelayMs(4)).toBe(300_000);
    expect(backoffDelayMs(5)).toBe(300_000); // capped
    expect(backoffDelayMs(50)).toBe(300_000);
    expect(backoffDelayMs(0)).toBe(0);
  });

  it("nextAttemptAt = failedAt + delay", () => {
    expect(nextAttemptAt(1, 1_000_000)).toBe(1_030_000);
    expect(nextAttemptAt(3, 0)).toBe(120_000);
  });

  it("isDue honors backoff windows and never retries SYNCED", () => {
    const now = 10_000;
    expect(isDue({ status: "PENDING", nextAttemptAt: now - 1 }, now)).toBe(true);
    expect(isDue({ status: "PENDING", nextAttemptAt: now + 1 }, now)).toBe(false);
    expect(isDue({ status: "FAILED", nextAttemptAt: now - 1 }, now)).toBe(true);
    expect(isDue({ status: "SYNCED", nextAttemptAt: 0 }, now)).toBe(false);
  });
});

describe("offline references and idempotency keys", () => {
  it("offlineReference matches OFFLINE-YYYYMMDD-NNNNNN", () => {
    const ref = offlineReference(new Date("2026-10-08T12:00:00Z"));
    expect(ref).toMatch(/^OFFLINE-\d{8}-\d{6}$/);
    expect(ref.startsWith("OFFLINE-20261008")).toBe(true);
  });

  it("newClientTransactionId generates unique ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newClientTransactionId()));
    expect(ids.size).toBe(500);
    const first = newClientTransactionId();
    expect(first.length).toBeGreaterThanOrEqual(8);
  });
});

/* ------------------------------ db layer ---------------------------- */

describe("IndexedDB queue", () => {
  it("enqueues a sale and reports it as unsynced", async () => {
    await enqueueSale(queuedSale());
    expect(await countUnsynced()).toBe(1);
    const list = await listPendingQueue();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("PENDING");
  });

  it("keeps local receipt history for every queued sale", async () => {
    const sale = queuedSale({ total: 250, itemCount: 3 });
    await enqueueSale(sale);
    const history = await listLocalSales();
    expect(history).toHaveLength(1);
    expect(history[0].total).toBe(250);
    expect(history[0].itemCount).toBe(3);
  });

  it("markSynced updates the queue AND the local history (invoice replaces offline ref)", async () => {
    const sale = queuedSale();
    await enqueueSale(sale);
    await markSynced(sale.clientTransactionId, "INV-00042");
    const entry = await getQueuedSale(sale.clientTransactionId);
    expect(entry?.status).toBe("SYNCED");
    expect(entry?.syncedInvoiceNumber).toBe("INV-00042");
    expect(await countUnsynced()).toBe(0);
    const history = await listLocalSales();
    expect(history[0].syncedInvoiceNumber).toBe("INV-00042");
    expect(history[0].offlineRef).toBe(sale.offlineRef); // audit trail kept
  });

  it("offline stock deduction only counts completed sales still pending/syncing", async () => {
    await enqueueSale(queuedSale({ clientTransactionId: "a-1" })); // completed PENDING
    await enqueueSale(
      queuedSale({
        clientTransactionId: "a-2",
        payload: { ...queuedSale().payload, status: "held" },
      })
    );
    await enqueueSale(
      queuedSale({
        clientTransactionId: "a-3",
        status: "FAILED",
        payload: {
          ...queuedSale().payload,
          items: [{ productId: "p1", quantity: 99, unitDiscount: 0 }],
        },
      })
    );
    const sold = await getOfflineSoldQuantities();
    expect(sold.get("p1")).toBe(2); // only the pending completed sale
    await markSynced("a-1", "INV-1");
    const after = await getOfflineSoldQuantities();
    expect(after.get("p1")).toBeUndefined(); // synced → server stock already reflects it
  });

  it("records sync conflicts and can resolve them", async () => {
    await addConflict({
      id: "c1",
      clientTransactionId: "x",
      kind: "STOCK_CONFLICT",
      productId: "p1",
      message: "INSUFFICIENT_STOCK: Insufficient stock for Cola",
      createdAt: Date.now(),
      resolved: false,
    });
    let open = await listConflicts();
    expect(open).toHaveLength(1);
    await resolveConflict("c1");
    open = await listConflicts();
    expect(open).toHaveLength(0);
    expect(await listConflicts(true)).toHaveLength(1);
  });
});

describe("catalog + customer cache", () => {
  const cola = {
    _id: "p1",
    name: "Cola 500ml",
    sku: "SKU-1",
    barcode: "8901234500011",
    sellingPrice: 50,
    discountPrice: 0,
    taxRate: 0,
    currentStock: 12,
  };

  it("cacheCatalog replaces, upsertCachedProducts merges", async () => {
    await cacheCatalog([cola], [{ _id: "c1", name: "Drinks" }]);
    await upsertCachedProducts([{ ...cola, _id: "p2", name: "Chips" }]);
    const products = await getCachedProducts();
    expect(products).toHaveLength(2);
    expect(await getCachedCategories()).toHaveLength(1);

    await cacheCatalog([cola], [{ _id: "c1", name: "Drinks" }]); // full refresh replaces
    expect(await getCachedProducts()).toHaveLength(1);
  });

  it("finds products offline by exact barcode and case-insensitive SKU", async () => {
    await cacheCatalog([cola], []);
    const byBarcode = await findCachedProductByBarcode("8901234500011");
    expect(byBarcode?.name).toBe("Cola 500ml");
    const bySku = await findCachedProductByBarcode("sku-1");
    expect(bySku?._id).toBe("p1");
    expect(await findCachedProductByBarcode("nope")).toBeNull();
  });

  it("caches customers and keeps meta kv", async () => {
    await upsertCachedCustomers([{ _id: "cu1", name: "Ahmad", phone: "070", balance: 0 }]);
    expect(await getCachedCustomers()).toHaveLength(1);
    await setMeta("lastSyncAt", 123);
    expect(await getMeta<number>("lastSyncAt")).toBe(123);
    expect(await getMeta<string>("missing")).toBeNull();
  });
});

/* ---------------------------- sync engine --------------------------- */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("sync engine", () => {
  it("pushes queued sales with the idempotency key and marks them synced", async () => {
    const sale = queuedSale();
    await enqueueSale(sale);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { success: true, data: { invoiceNumber: "INV-100" } },
        201
      )
    );

    const result = await syncNow({ force: true });
    expect(result.synced).toBe(1);
    expect(result.remaining).toBe(0);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.clientTransactionId).toBe(sale.clientTransactionId);
    expect(body.items).toEqual(sale.payload.items);

    const entry = await getQueuedSale(sale.clientTransactionId);
    expect(entry?.status).toBe("SYNCED");
    expect(entry?.syncedInvoiceNumber).toBe("INV-100");
  });

  it("treats an already-synced replay as success (no double sale)", async () => {
    const sale = queuedSale();
    await enqueueSale(sale);

    // Server says: this transaction id was already processed.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, alreadySynced: true, data: { invoiceNumber: "INV-77" } }, 200)
    );

    const result = await syncNow({ force: true });
    expect(result.synced).toBe(1);
    const entry = await getQueuedSale(sale.clientTransactionId);
    expect(entry?.status).toBe("SYNCED");
    expect(entry?.syncedInvoiceNumber).toBe("INV-77");
  });

  it("schedules a 30s backoff when the network fails mid-sync", async () => {
    const sale = queuedSale();
    await enqueueSale(sale);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const before = Date.now();
    const result = await syncNow({ force: true });
    expect(result.synced).toBe(0);
    expect(result.remaining).toBe(1);

    const entry = await getQueuedSale(sale.clientTransactionId);
    expect(entry?.status).toBe("PENDING");
    expect(entry?.attempts).toBe(1);
    expect(entry?.nextAttemptAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(entry?.nextAttemptAt).toBeLessThan(before + 65_000);
  });

  it("does not auto-retry entries still inside their backoff window", async () => {
    await enqueueSale(queuedSale({ nextAttemptAt: Date.now() + 10 * 60_000, attempts: 4 }));
    const result = await syncNow(); // no force
    expect(result.synced).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.remaining).toBe(1);
  });

  it("force (Sync now) bypasses the backoff window", async () => {
    const sale = queuedSale({ nextAttemptAt: Date.now() + 10 * 60_000, attempts: 4 });
    await enqueueSale(sale);
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { invoiceNumber: "INV-9" } }, 201));

    const result = await syncNow({ force: true });
    expect(result.synced).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks stock conflicts as FAILED and records a conflict (never overwrites)", async () => {
    const sale = queuedSale();
    await enqueueSale(sale);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { success: false, error: { code: "INSUFFICIENT_STOCK", message: "Insufficient stock for Cola", conflict: true } },
        409
      )
    );

    const result = await syncNow({ force: true });
    expect(result.failed).toBe(1);
    expect(result.synced).toBe(0);

    const entry = await getQueuedSale(sale.clientTransactionId);
    expect(entry?.status).toBe("FAILED");
    expect(entry?.lastError).toContain("INSUFFICIENT_STOCK");

    const conflicts = await listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("STOCK_CONFLICT");
    // No further automatic attempts for permanent failures.
    expect(entry!.nextAttemptAt).toBeGreaterThan(Date.now() + 3_600_000);
  });

  it("marks permanent 400 validation errors as FAILED", async () => {
    const sale = queuedSale();
    await enqueueSale(sale);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: "INVALID_PAYMENT", message: "Payments exceed total" } }, 400)
    );
    const result = await syncNow({ force: true });
    expect(result.failed).toBe(1);
    const entry = await getQueuedSale(sale.clientTransactionId);
    expect(entry?.status).toBe("FAILED");
    expect(entry?.lastError).toContain("INVALID_PAYMENT");
  });

  it("retries transient 5xx errors with backoff instead of failing", async () => {
    const sale = queuedSale();
    await enqueueSale(sale);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Internal error" }, 500));

    const result = await syncNow({ force: true });
    expect(result.failed).toBe(0);
    expect(result.synced).toBe(0);
    const entry = await getQueuedSale(sale.clientTransactionId);
    expect(entry?.status).toBe("PENDING");
    expect(entry?.attempts).toBe(1);
    expect(entry?.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it("retryEntry requeues a FAILED sale for immediate sync", async () => {
    const sale = queuedSale({ status: "FAILED", nextAttemptAt: Number.MAX_SAFE_INTEGER, attempts: 3 });
    await enqueueSale(sale);
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { invoiceNumber: "INV-2" } }, 201));

    const entry = await getQueuedSale(sale.clientTransactionId);
    await retryEntry(sale.clientTransactionId, entry!);
    const result = await syncNow({ force: true });
    expect(result.synced).toBe(1);
  });

  it("does nothing while the device is offline", async () => {
    await enqueueSale(queuedSale());
    setConnectionStatus("OFFLINE");
    const result = await syncNow({ force: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.remaining).toBe(1);
    setConnectionStatus("ONLINE");
  });

  it("processes the queue strictly in creation order (oldest first)", async () => {
    const first = queuedSale({ createdAt: 1000, offlineRef: "OFFLINE-00000000-000001" });
    const second = queuedSale({ createdAt: 2000, offlineRef: "OFFLINE-00000000-000002" });
    await enqueueSale(first);
    await enqueueSale(second);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { invoiceNumber: "A" } }, 201))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { invoiceNumber: "B" } }, 201));

    await syncNow({ force: true });
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(firstBody.clientTransactionId).toBe(first.clientTransactionId);
    expect(secondBody.clientTransactionId).toBe(second.clientTransactionId);
    expect((await getQueuedSale(first.clientTransactionId))?.syncedInvoiceNumber).toBe("A");
    expect((await getQueuedSale(second.clientTransactionId))?.syncedInvoiceNumber).toBe("B");
  });
});
