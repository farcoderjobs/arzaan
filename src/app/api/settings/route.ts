import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden } from "@/lib/api";
import {
  getStoreSettings,
  setStoreSetting,
  SETTING_KEYS,
  DEFAULT_SETTINGS,
  StoreSettingsGroup,
} from "@/lib/settings";
import { recordAuditLog, requestMeta } from "@/lib/audit";

/**
 * Settings API.
 * GET  /api/settings → grouped settings (store / pos / inventory)
 * POST /api/settings → update one or many settings (settings.manage permission)
 *
 * Field whitelist keeps unknown keys out; values are validated per-field.
 */

const updateSchema = z.object({
  fields: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()])
  ),
});

type FieldValidator = (v: unknown) => { ok: true; value: unknown } | { ok: false; error: string };

function str(v: unknown, min: number, max: number): ReturnType<FieldValidator> {
  const s = String(v ?? "").trim();
  if (s.length < min || s.length > max) return { ok: false, error: `Must be ${min}-${max} characters` };
  return { ok: true, value: s };
}
function num(v: unknown, min: number, max: number): ReturnType<FieldValidator> {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return { ok: false, error: `Must be a number between ${min} and ${max}` };
  return { ok: true, value: n };
}
function bool(v: unknown): ReturnType<FieldValidator> {
  return { ok: true, value: v === true || v === "true" };
}
const PAYMENT_METHODS = ["cash", "card", "transfer", "credit", "bonus", "exchange"];
function csvMethods(v: unknown): ReturnType<FieldValidator> {
  const list = String(v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return { ok: false, error: "Choose at least one payment method" };
  if (list.some((m) => !PAYMENT_METHODS.includes(m))) {
    return { ok: false, error: `Methods must be one of: ${PAYMENT_METHODS.join(", ")}` };
  }
  return { ok: true, value: [...new Set(list)].join(",") };
}
/** Comma-separated Mongo ObjectIds (category exclusions). Empty = none. */
function csvIds(v: unknown): ReturnType<FieldValidator> {
  const list = String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.some((id) => !/^[a-f0-9]{24}$/i.test(id))) {
    return { ok: false, error: "Exclusions must be a comma-separated list of category ids" };
  }
  return { ok: true, value: [...new Set(list)].join(",") };
}

const FIELD_VALIDATORS: Record<string, FieldValidator> = {
  [SETTING_KEYS.storeName]: (v) => str(v, 1, 120),
  [SETTING_KEYS.logoUrl]: (v) => str(v, 0, 500),
  [SETTING_KEYS.address]: (v) => str(v, 0, 300),
  [SETTING_KEYS.phone]: (v) => str(v, 0, 50),
  [SETTING_KEYS.email]: (v) => (v === "" || /^\\S+@\\S+\\.\\S+$/.test(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: "Invalid email" }),
  [SETTING_KEYS.currency]: (v) => (/^[A-Za-z]{3}$/.test(String(v)) ? { ok: true, value: String(v).toUpperCase() } : { ok: false, error: "Currency must be a 3-letter code" }),
  [SETTING_KEYS.taxRate]: (v) => num(v, 0, 100),
  [SETTING_KEYS.invoicePrefix]: (v) => (/^[A-Za-z0-9_-]{0,10}$/.test(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: "Prefix: letters, numbers, - and _ (max 10)" }),

  [SETTING_KEYS.allowNegativeStock]: bool,
  [SETTING_KEYS.maxCashierDiscountPercent]: (v) => num(v, 0, 100),
  [SETTING_KEYS.requireCustomerForCredit]: bool,
  [SETTING_KEYS.autoPrintReceipt]: bool,
  [SETTING_KEYS.refundRequiresApproval]: bool,
  [SETTING_KEYS.defaultPaymentMethod]: (v) => (["cash", "card", "transfer", "credit"].includes(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: "Invalid payment method" }),
  [SETTING_KEYS.bonusRedemptionEnabled]: bool,
  [SETTING_KEYS.bonusMaxRedeemPercent]: (v) => num(v, 0, 100),
  [SETTING_KEYS.bonusEarnBasis]: (v) =>
    ["net_merchandise", "amount_paid"].includes(String(v))
      ? { ok: true, value: String(v) }
      : { ok: false, error: "Invalid bonus earning basis" },

  // Customer loyalty bonus
  [SETTING_KEYS.customerBonusEnabled]: bool,
  [SETTING_KEYS.customerBonusDefaultPercent]: (v) => num(v, 0, 100),
  [SETTING_KEYS.bonusMinPurchaseAmount]: (v) => num(v, 0, 1_000_000_000),
  [SETTING_KEYS.bonusMinRedeemBalance]: (v) => num(v, 0, 1_000_000_000),
  [SETTING_KEYS.bonusEligiblePaymentMethods]: (v) => csvMethods(v),
  [SETTING_KEYS.bonusWholesaleQualifies]: bool,
  [SETTING_KEYS.bonusDirectQualifies]: bool,
  [SETTING_KEYS.bonusExcludedCategoryIds]: (v) => csvIds(v),
  [SETTING_KEYS.bonusExpiryDays]: (v) => num(v, 0, 3650),
  [SETTING_KEYS.bonusSameTransactionRedeem]: bool,
  [SETTING_KEYS.bonusRestoreRedeemedOnRefund]: bool,

  // Employee purchase benefit
  [SETTING_KEYS.employeePurchaseEnabled]: bool,
  [SETTING_KEYS.employeeBenefitDefaultPercent]: (v) => num(v, 0, 100),
  [SETTING_KEYS.employeeBenefitMode]: (v) =>
    ["percent", "fixed"].includes(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: "Invalid benefit mode" },
  [SETTING_KEYS.employeeBenefitFixedAmount]: (v) => num(v, 0, 1_000_000_000),
  [SETTING_KEYS.employeeBenefitWholesaleAllowed]: bool,
  [SETTING_KEYS.employeeCreditAllowed]: bool,
  [SETTING_KEYS.employeeDeductionMode]: (v) =>
    ["payroll", "immediate"].includes(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: "Invalid deduction mode" },
  [SETTING_KEYS.employeeMaxMonthlyPurchase]: (v) => num(v, 0, 1_000_000_000),
  [SETTING_KEYS.employeeMaxMonthlyDeduction]: (v) => num(v, 0, 1_000_000_000),
  [SETTING_KEYS.employeeExcludedCategoryIds]: (v) => csvIds(v),

  [SETTING_KEYS.lowStockThreshold]: (v) => num(v, 0, 1_000_000),
  [SETTING_KEYS.allowNegativeInventory]: bool,
  [SETTING_KEYS.inventoryValuation]: (v) => (["fifo", "average", "standard"].includes(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: "Invalid valuation method" }),
};

function toGroups(s: StoreSettingsGroup) {
  return {
    store: {
      storeName: s.storeName,
      logoUrl: s.logoUrl,
      address: s.address,
      phone: s.phone,
      email: s.email,
      currency: s.currency,
      taxRate: s.taxRate,
      invoicePrefix: s.invoicePrefix,
    },
    pos: {
      allowNegativeStock: s.allowNegativeStock,
      maxCashierDiscountPercent: s.maxCashierDiscountPercent,
      requireCustomerForCredit: s.requireCustomerForCredit,
      autoPrintReceipt: s.autoPrintReceipt,
      refundRequiresApproval: s.refundRequiresApproval,
      defaultPaymentMethod: s.defaultPaymentMethod,
      bonusRedemptionEnabled: s.bonusRedemptionEnabled,
      bonusMaxRedeemPercent: s.bonusMaxRedeemPercent,
      bonusEarnBasis: s.bonusEarnBasis,
    },
    bonus: {
      customerBonusEnabled: s.customerBonusEnabled,
      customerBonusDefaultPercent: s.customerBonusDefaultPercent,
      bonusRedemptionEnabled: s.bonusRedemptionEnabled,
      bonusMaxRedeemPercent: s.bonusMaxRedeemPercent,
      bonusMinPurchaseAmount: s.bonusMinPurchaseAmount,
      bonusMinRedeemBalance: s.bonusMinRedeemBalance,
      bonusEligiblePaymentMethods: s.bonusEligiblePaymentMethods,
      bonusWholesaleQualifies: s.bonusWholesaleQualifies,
      bonusDirectQualifies: s.bonusDirectQualifies,
      bonusExcludedCategoryIds: s.bonusExcludedCategoryIds,
      bonusExpiryDays: s.bonusExpiryDays,
      bonusSameTransactionRedeem: s.bonusSameTransactionRedeem,
      bonusRestoreRedeemedOnRefund: s.bonusRestoreRedeemedOnRefund,
      employeePurchaseEnabled: s.employeePurchaseEnabled,
      employeeBenefitDefaultPercent: s.employeeBenefitDefaultPercent,
      employeeBenefitMode: s.employeeBenefitMode,
      employeeBenefitFixedAmount: s.employeeBenefitFixedAmount,
      employeeBenefitWholesaleAllowed: s.employeeBenefitWholesaleAllowed,
      employeeCreditAllowed: s.employeeCreditAllowed,
      employeeDeductionMode: s.employeeDeductionMode,
      employeeMaxMonthlyPurchase: s.employeeMaxMonthlyPurchase,
      employeeMaxMonthlyDeduction: s.employeeMaxMonthlyDeduction,
      employeeExcludedCategoryIds: s.employeeExcludedCategoryIds,
    },
    inventory: {
      lowStockThreshold: s.lowStockThreshold,
      allowNegativeInventory: s.allowNegativeInventory,
      inventoryValuation: s.inventoryValuation,
    },
    defaults: DEFAULT_SETTINGS,
    keys: SETTING_KEYS,
  };
}

export async function GET() {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.settings.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const settings = await getStoreSettings(user.branchId);
    return NextResponse.json(toGroups(settings));
  } catch (error) {
    console.error("GET /api/settings error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.settings.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }
    const meta = requestMeta(req);

    const parsed = updateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed"), { status: 400 });
    }

    const fields = parsed.data.fields;
    const updates: Array<{ key: string; value: unknown }> = [];

    for (const [field, value] of Object.entries(fields)) {
      const key = Object.values(SETTING_KEYS).find((k) => k === field);
      if (!key) {
        return NextResponse.json(badRequest(`Unknown setting: ${field}`), { status: 400 });
      }
      const validator = FIELD_VALIDATORS[key];
      if (!validator) {
        return NextResponse.json(badRequest(`Unknown setting: ${field}`), { status: 400 });
      }
      const result = validator(value);
      if (!result.ok) {
        return NextResponse.json(badRequest(`${field}: ${result.error}`), { status: 400 });
      }
      updates.push({ key, value: result.value });
    }

    for (const { key, value } of updates) {
      await setStoreSetting(user.branchId, key, value, user.id);
      await recordAuditLog({
        user,
        action: "settings.update",
        entityType: "StoreSettings",
        entityId: null,
        note: `${key} → ${JSON.stringify(value)}`,
        newValue: value,
        ...meta,
      });
    }

    const settings = await getStoreSettings(user.branchId);
    return NextResponse.json(success(toGroups(settings), "Settings saved"));
  } catch (error) {
    console.error("POST /api/settings error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
