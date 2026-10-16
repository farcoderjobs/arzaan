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
