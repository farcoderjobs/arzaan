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
 *  - bonus    → customer loyalty bonus policy and employee purchase benefit policy
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
  bonusRedemptionEnabled: boolean;
  /** Maximum share of the sale total payable with reward credit (0-100). */
  bonusMaxRedeemPercent: number;
  bonusEarnBasis: "net_merchandise" | "amount_paid";

  // Customer loyalty bonus
  /** Master switch for EARNING loyalty bonus (redemption has its own flag). */
  customerBonusEnabled: boolean;
  /** Rate used when a customer has no explicit rate of their own. */
  customerBonusDefaultPercent: number;
  /** Smallest purchase that earns bonus (0 = every sale). */
  bonusMinPurchaseAmount: number;
  /** Smallest balance a customer may redeem (0 = any positive balance). */
  bonusMinRedeemBalance: number;
  /** Payment methods that make a sale bonus-eligible (CSV, e.g. "cash,card"). */
  bonusEligiblePaymentMethods: string;
  /** Wholesale-priced lines earn bonus when true. */
  bonusWholesaleQualifies: boolean;
  /** Direct-sale (non-inventory) lines earn bonus when true. */
  bonusDirectQualifies: boolean;
  /** Categories that never earn bonus (CSV of category ids). */
  bonusExcludedCategoryIds: string;
  /** Days until earned bonus expires (0 = never). */
  bonusExpiryDays: number;
  /** Whether bonus earned on this sale may be spent on the same sale. */
  bonusSameTransactionRedeem: boolean;
  /** Restore redeemed bonus when a sale is refunded, per the refund policy. */
  bonusRestoreRedeemedOnRefund: boolean;

  // Employee purchase benefit (payroll-recovered employee discount)
  employeePurchaseEnabled: boolean;
  employeeBenefitDefaultPercent: number;
  employeeBenefitMode: "percent" | "fixed";
  employeeBenefitFixedAmount: number;
  employeeBenefitWholesaleAllowed: boolean;
  employeeCreditAllowed: boolean;
  /** payroll = unpaid net is recovered by salary; immediate = must be paid now. */
  employeeDeductionMode: "payroll" | "immediate";
  /** Maximum value an employee may buy per month (0 = unlimited). */
  employeeMaxMonthlyPurchase: number;
  /** Maximum salary deduction per month (0 = unlimited). */
  employeeMaxMonthlyDeduction: number;
  /** Categories excluded from the employee benefit (CSV of category ids). */
  employeeExcludedCategoryIds: string;

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
  bonusRedemptionEnabled: true,
  bonusMaxRedeemPercent: 100,
  bonusEarnBasis: "net_merchandise",

  customerBonusEnabled: true,
  customerBonusDefaultPercent: 2,
  bonusMinPurchaseAmount: 0,
  bonusMinRedeemBalance: 0,
  bonusEligiblePaymentMethods: "cash,card,transfer,credit",
  bonusWholesaleQualifies: false,
  bonusDirectQualifies: true,
  bonusExcludedCategoryIds: "",
  bonusExpiryDays: 0,
  bonusSameTransactionRedeem: false,
  bonusRestoreRedeemedOnRefund: true,

  employeePurchaseEnabled: true,
  employeeBenefitDefaultPercent: 5,
  employeeBenefitMode: "percent",
  employeeBenefitFixedAmount: 0,
  employeeBenefitWholesaleAllowed: false,
  employeeCreditAllowed: true,
  employeeDeductionMode: "payroll",
  employeeMaxMonthlyPurchase: 0,
  employeeMaxMonthlyDeduction: 0,
  employeeExcludedCategoryIds: "",

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
  bonusRedemptionEnabled: "pos.bonus_redemption_enabled",
  bonusMaxRedeemPercent: "pos.bonus_max_redeem_percent",
  bonusEarnBasis: "pos.bonus_earn_basis",

  customerBonusEnabled: "bonus.customer_enabled",
  customerBonusDefaultPercent: "bonus.customer_default_percent",
  bonusMinPurchaseAmount: "bonus.min_purchase_amount",
  bonusMinRedeemBalance: "bonus.min_redeem_balance",
  bonusEligiblePaymentMethods: "bonus.eligible_payment_methods",
  bonusWholesaleQualifies: "bonus.wholesale_qualifies",
  bonusDirectQualifies: "bonus.direct_qualifies",
  bonusExcludedCategoryIds: "bonus.excluded_category_ids",
  bonusExpiryDays: "bonus.expiry_days",
  bonusSameTransactionRedeem: "bonus.same_transaction_redeem",
  bonusRestoreRedeemedOnRefund: "bonus.restore_redeemed_on_refund",

  employeePurchaseEnabled: "employee.purchase_enabled",
  employeeBenefitDefaultPercent: "employee.benefit_default_percent",
  employeeBenefitMode: "employee.benefit_mode",
  employeeBenefitFixedAmount: "employee.benefit_fixed_amount",
  employeeBenefitWholesaleAllowed: "employee.wholesale_allowed",
  employeeCreditAllowed: "employee.credit_allowed",
  employeeDeductionMode: "employee.deduction_mode",
  employeeMaxMonthlyPurchase: "employee.max_monthly_purchase",
  employeeMaxMonthlyDeduction: "employee.max_monthly_deduction",
  employeeExcludedCategoryIds: "employee.excluded_category_ids",

  lowStockThreshold: "inventory.low_stock_threshold",
  allowNegativeInventory: "inventory.allow_negative",
  inventoryValuation: "inventory.valuation",
} as const;

const NUMBER_KEYS = new Set<string>([
  SETTING_KEYS.taxRate,
  SETTING_KEYS.maxCashierDiscountPercent,
  SETTING_KEYS.lowStockThreshold,
  SETTING_KEYS.bonusMaxRedeemPercent,
  SETTING_KEYS.customerBonusDefaultPercent,
  SETTING_KEYS.bonusMinPurchaseAmount,
  SETTING_KEYS.bonusMinRedeemBalance,
  SETTING_KEYS.bonusExpiryDays,
  SETTING_KEYS.employeeBenefitDefaultPercent,
  SETTING_KEYS.employeeBenefitFixedAmount,
  SETTING_KEYS.employeeMaxMonthlyPurchase,
  SETTING_KEYS.employeeMaxMonthlyDeduction,
]);
const BOOLEAN_KEYS = new Set<string>([
  SETTING_KEYS.allowNegativeStock,
  SETTING_KEYS.requireCustomerForCredit,
  SETTING_KEYS.autoPrintReceipt,
  SETTING_KEYS.refundRequiresApproval,
  SETTING_KEYS.allowNegativeInventory,
  SETTING_KEYS.bonusRedemptionEnabled,
  SETTING_KEYS.customerBonusEnabled,
  SETTING_KEYS.bonusWholesaleQualifies,
  SETTING_KEYS.bonusDirectQualifies,
  SETTING_KEYS.bonusSameTransactionRedeem,
  SETTING_KEYS.bonusRestoreRedeemedOnRefund,
  SETTING_KEYS.employeePurchaseEnabled,
  SETTING_KEYS.employeeBenefitWholesaleAllowed,
  SETTING_KEYS.employeeCreditAllowed,
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
  SETTING_KEYS.bonusEarnBasis,
  SETTING_KEYS.bonusEligiblePaymentMethods,
  SETTING_KEYS.bonusExcludedCategoryIds,
  SETTING_KEYS.employeeBenefitMode,
  SETTING_KEYS.employeeDeductionMode,
  SETTING_KEYS.employeeExcludedCategoryIds,
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
  [SETTING_KEYS.bonusRedemptionEnabled]: "bonusRedemptionEnabled",
  [SETTING_KEYS.bonusMaxRedeemPercent]: "bonusMaxRedeemPercent",
  [SETTING_KEYS.bonusEarnBasis]: "bonusEarnBasis",
  [SETTING_KEYS.customerBonusEnabled]: "customerBonusEnabled",
  [SETTING_KEYS.customerBonusDefaultPercent]: "customerBonusDefaultPercent",
  [SETTING_KEYS.bonusMinPurchaseAmount]: "bonusMinPurchaseAmount",
  [SETTING_KEYS.bonusMinRedeemBalance]: "bonusMinRedeemBalance",
  [SETTING_KEYS.bonusEligiblePaymentMethods]: "bonusEligiblePaymentMethods",
  [SETTING_KEYS.bonusWholesaleQualifies]: "bonusWholesaleQualifies",
  [SETTING_KEYS.bonusDirectQualifies]: "bonusDirectQualifies",
  [SETTING_KEYS.bonusExcludedCategoryIds]: "bonusExcludedCategoryIds",
  [SETTING_KEYS.bonusExpiryDays]: "bonusExpiryDays",
  [SETTING_KEYS.bonusSameTransactionRedeem]: "bonusSameTransactionRedeem",
  [SETTING_KEYS.bonusRestoreRedeemedOnRefund]: "bonusRestoreRedeemedOnRefund",
  [SETTING_KEYS.employeePurchaseEnabled]: "employeePurchaseEnabled",
  [SETTING_KEYS.employeeBenefitDefaultPercent]: "employeeBenefitDefaultPercent",
  [SETTING_KEYS.employeeBenefitMode]: "employeeBenefitMode",
  [SETTING_KEYS.employeeBenefitFixedAmount]: "employeeBenefitFixedAmount",
  [SETTING_KEYS.employeeBenefitWholesaleAllowed]: "employeeBenefitWholesaleAllowed",
  [SETTING_KEYS.employeeCreditAllowed]: "employeeCreditAllowed",
  [SETTING_KEYS.employeeDeductionMode]: "employeeDeductionMode",
  [SETTING_KEYS.employeeMaxMonthlyPurchase]: "employeeMaxMonthlyPurchase",
  [SETTING_KEYS.employeeMaxMonthlyDeduction]: "employeeMaxMonthlyDeduction",
  [SETTING_KEYS.employeeExcludedCategoryIds]: "employeeExcludedCategoryIds",
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
