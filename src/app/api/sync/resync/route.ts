import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden, success } from "@/lib/api";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { markAllDirty, resetStuckRows } from "@/lib/sync/outbox";
import { syncNow } from "@/lib/sync/worker";

/**
 * POST /api/sync/resync — recovery path.
 *
 * Marks every replicated document dirty again and runs a sync, which covers the
 * situations where the local database is the source of truth but the center is
 * behind:
 *
 *  - the center database was restored from a backup or rebuilt from scratch,
 *  - a marker write failed (recorded as `tracking.lastError`),
 *  - a node was pointed at a different center.
 *
 * Safe to run repeatedly: applied rows are deduplicated by the center's ledger,
 * so re-pushing cannot duplicate a sale.
 */
export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.settings.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    await resetStuckRows();
    const marked = await markAllDirty();
    const summary = await syncNow({ force: true, kind: "resync" });

    await recordAuditLog({
      user,
      action: "sync.resync",
      entityType: "SyncNode",
      entityId: null,
      branchId: user.branchId,
      note: `Full re-push: ${marked} document(s) marked, ${summary.message}`,
      newValue: { marked, ...summary },
      ...requestMeta(req),
    });

    return NextResponse.json(
      success({ marked, summary }, `${marked} document(s) queued for a full re-push`)
    );
  } catch (error) {
    console.error("POST /api/sync/resync error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
