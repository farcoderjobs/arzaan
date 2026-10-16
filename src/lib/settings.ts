import mongoose from "mongoose";
import { StoreSettings } from "@/models";

/**
 * Store settings service. Settings are stored per-branch as key/value rows
 * (StoreSettings collection) and read through a typed accessor with defaults.
 *
 * Groups:
 *  - store    → name, logo, address, phone, email, currency, taxRate, invoicePrefix
 *  - pos      → allowNegativeStock, maxCashierDiscountPercent, requireCustomerForCredit,
 *               autoPrintReceipt, refundRequiresApproval, defaultPaymentMethod
 *  - inventory→ lowStockThreshold, allowNegativeInventory, valuationMethod
 */

export type StoreSettingsGroup = {
  storeName: string;
  logoUrl: string;
  address: string;
  phone: string;
  email: string;
  currency: string;
  taxRate: number;
  invoicePrefix: string;

  // POS
  allowNegativeStock: boolean;
  maxCashierDiscountPercent: number;
  requireCustomerForCredit: boolean;
  autoPrintReceipt: boolean;
  refundRequiresApproval: boolean;
  defaultPaymentMethod: "cash" | "card" | "transfer" | "credit";

  // Inventory
  lowStockThreshold: number;
  allowNegativeInventory: boolean;
  inventoryValuation: "fifo" | "average" | "standard";
};

export const DEFAULT_SETTINGS: StoreSettingsGroup = {
  storeName: "POS System",
  logoUrl: "",
  address: "",
  phone: "",
  email: "",
  currency: "AFN",
  taxRate: 0,
  invoicePrefix: "INV",

  allowNegativeStock: false,
  maxCashierDiscountPercent: 10,
  requireCustomerForCredit: true,
  autoPrintReceipt: true,
  refundRequiresApproval: false,
  defaultPaymentMethod: "cash",

  lowStockThreshold: 10,
  allowNegativeInventory: false,
  inventoryValuation: "average",
};

export const SETTING_KEYS = {
  storeName: "store.name",
  logoUrl: "store.logo",
  address: "store.address",
  phone: "store.phone",
  email: "store.email",
  currency: "store.currency",
  taxRate: "store.tax_rate",
  invoicePrefix: "store.invoice_prefix",

  allowNegativeStock: "pos.allow_negative_stock",
  maxCashierDiscountPercent: "pos.max_cashier_discount_percent",
  requireCustomerForCredit: "pos.require_customer_for_credit",
  autoPrintReceipt: "pos.auto_print_receipt",
  refundRequiresApproval: "pos.refund_requires_approval",
  defaultPaymentMethod: "pos.default_payment_method",

  lowStockThreshold: "inventory.low_stock_threshold",
  allowNegativeInventory: "inventory.allow_negative",
  inventoryValuation: "inventory.valuation",
} as const;

const NUMBER_KEYS = new Set<string>([SETTING_KEYS.taxRate, SETTING_KEYS.maxCashierDiscountPercent, SETTING_KEYS.lowStockThreshold]);
const BOOLEAN_KEYS = new Set<string>([
  SETTING_KEYS.allowNegativeStock,
  SETTING_KEYS.requireCustomerForCredit,
  SETTING_KEYS.autoPrintReceipt,
  SETTING_KEYS.refundRequiresApproval,
  SETTING_KEYS.allowNegativeInventory,
]);
const STRING_KEYS = new Set<string>([
  SETTING_KEYS.storeName,
  SETTING_KEYS.logoUrl,
  SETTING_KEYS.address,
  SETTING_KEYS.phone,
  SETTING_KEYS.email,
  SETTING_KEYS.currency,
  SETTING_KEYS.invoicePrefix,
  SETTING_KEYS.defaultPaymentMethod,
  SETTING_KEYS.inventoryValuation,
]);

const KEY_TO_FIELD: Record<string, string> = {
  [SETTING_KEYS.storeName]: "storeName",
  [SETTING_KEYS.logoUrl]: "logoUrl",
  [SETTING_KEYS.address]: "address",
  [SETTING_KEYS.phone]: "phone",
  [SETTING_KEYS.email]: "email",
  [SETTING_KEYS.currency]: "currency",
  [SETTING_KEYS.taxRate]: "taxRate",
  [SETTING_KEYS.invoicePrefix]: "invoicePrefix",
  [SETTING_KEYS.allowNegativeStock]: "allowNegativeStock",
  [SETTING_KEYS.maxCashierDiscountPercent]: "maxCashierDiscountPercent",
  [SETTING_KEYS.requireCustomerForCredit]: "requireCustomerForCredit",
  [SETTING_KEYS.autoPrintReceipt]: "autoPrintReceipt",
  [SETTING_KEYS.refundRequiresApproval]: "refundRequiresApproval",
  [SETTING_KEYS.defaultPaymentMethod]: "defaultPaymentMethod",
  [SETTING_KEYS.lowStockThreshold]: "lowStockThreshold",
  [SETTING_KEYS.allowNegativeInventory]: "allowNegativeInventory",
  [SETTING_KEYS.inventoryValuation]: "inventoryValuation",
};

/** Branch-scoped settings cache (per server process, 30s TTL). */
type CacheEntry = { value: StoreSettingsGroup; expiresAt: number };
const settingsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

export function clearSettingsCache() {
  settingsCache.clear();
}

/** Reads all settings for a branch (global rows when branchId is null). */
export async function getStoreSettings(branchId: string | null): Promise<StoreSettingsGroup> {
  const cacheKey = branchId ?? "__global__";
  const cached = settingsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const result = { ...DEFAULT_SETTINGS };
  try {
    const query = branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : { branchId: { $exists: false } };
    const docs = await StoreSettings.find(query).select("key value").lean();
    for (const doc of docs) {
      applySetting(result, doc.key, doc.value);
    }
  } catch (err) {
    // DB not reachable — fall back to defaults rather than crashing callers.
    console.error("[settings] read failed, using defaults", err);
  }

  settingsCache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

function applySetting(target: StoreSettingsGroup, key: string, value: unknown) {
  const field = KEY_TO_FIELD[key];
  if (!field) return;
  const record = target as unknown as Record<string, unknown>;
  if (STRING_KEYS.has(key)) {
    record[field] = String(value ?? "");
  } else if (BOOLEAN_KEYS.has(key)) {
    record[field] = value === true || value === "true";
  } else if (NUMBER_KEYS.has(key)) {
    const n = Number(value);
    if (Number.isFinite(n)) record[field] = n;
  }
}

/** Upserts a single setting row. */
export async function setStoreSetting(
  branchId: string | null,
  key: string,
  value: unknown,
  updatedBy?: string | null
): Promise<void> {
  const query = branchId ? { branchId: new mongoose.Types.ObjectId(branchId), key } : { branchId: { $exists: false }, key };
  await StoreSettings.updateOne(
    query,
    { $set: { value, updatedBy: updatedBy ? new mongoose.Types.ObjectId(updatedBy) : null } },
    { upsert: true }
  );
  clearSettingsCache();
}

/** Reads a single setting with its typed default. */
export async function getSettingValue<T>(branchId: string | null, key: string, fallback: T): Promise<T> {
  try {
    const query = branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : { branchId: { $exists: false } };
    const doc = await StoreSettings.findOne({ ...query, key }).lean();
    if (!doc || doc.value === undefined || doc.value === null) return fallback;
    return doc.value as T;
  } catch {
    return fallback;
  }
}
