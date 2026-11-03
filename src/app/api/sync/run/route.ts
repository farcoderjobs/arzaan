import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden, success } from "@/lib/api";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { syncNow } from "@/lib/sync/worker";
import { withoutSyncTracking } from "@/lib/sync/tracking";
import type { NextRequest } from "next/server";

/**
 * POST /api/sync/run — "Sync now" / end-of-shift sync.
 *
 * Force-runs one push/pull pass. Rows due for a retry are pushed immediately,
 * FAILED rows are left alone (a human decides about those through the conflicts
 * endpoint). The response is the run summary the operator sees.
 */
export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.create))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const summary = await syncNow({ force: true, kind: "manual" });

    // Kept local on purpose: replicating this row would queue the audit of the
    // sync that just ran, so the outbox could never drain (every run leaves its
    // own entry pending). The run itself is recorded in `SyncRun`.
    await withoutSyncTracking(() =>
      recordAuditLog({
        user,
        action: "sync.run",
        entityType: "SyncRun",
        entityId: summary.runId || null,
        note: `Manual sync: ${summary.message}`,
        newValue: {
          pushed: summary.pushed,
          conflicted: summary.conflicted,
          failed: summary.failed,
          pulled: summary.pulled,
          remaining: summary.remaining,
        },
        ...requestMeta(req),
      })
    );

    return NextResponse.json(success(summary, summary.message));
  } catch (error) {
    console.error("POST /api/sync/run error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
