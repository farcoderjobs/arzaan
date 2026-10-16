import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { User, Role, Branch, StoreSettings, AuditLog } from "@/models";

export async function GET(_req: NextRequest) {
  try {
    await connectDB();
    const [
      users,
      roles,
      branches,
      settingsKeys,
      auditCount,
      roleWithPerms,
      globalSettings,
    ] = await Promise.all([
      User.countDocuments(),
      Role.countDocuments(),
      Branch.countDocuments(),
      StoreSettings.distinct("key"),
      AuditLog.countDocuments(),
      Role.findOne({ name: "SuperAdmin" }).populate("permissions", "name").lean(),
      StoreSettings.find({ branchId: { $exists: false } }).lean(),
    ]);

    // Global (non-branch) settings are the defaults for single-branch workflow.
    const globalSettingMap = new Map(globalSettings.map((s) => [s.key, String(s.value ?? "")]));
    const requiredGlobalKeys = [
      "store.name", "store.logo", "store.address", "store.phone", "store.email",
      "store.currency", "store.tax_rate", "store.invoice_prefix",
      "pos.allow_negative_stock", "pos.max_cashier_discount_percent", "pos.require_customer_for_credit",
      "pos.auto_print_receipt", "pos.refund_requires_approval", "pos.default_payment_method",
      "inventory.low_stock_threshold", "inventory.allow_negative", "inventory.valuation",
    ];
    const missingKeys = requiredGlobalKeys.filter((k) => !globalSettingMap.has(k));

    return NextResponse.json({
      ok: true,
      counts: { users, roles, branches, settingsKeys: settingsKeys.length, auditLogs: auditCount },
      superAdminPermissions: (roleWithPerms as { permissions: Array<{ name: string }> } | null)?.permissions.map((p) => p.name) ?? [],
      missingGlobalSettingKeys: missingKeys,
      sampleGlobalSettings: requiredGlobalKeys.map((k) => ({ key: k, value: globalSettingMap.get(k) ?? null })),
      seeded: roleWithPerms !== null,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
