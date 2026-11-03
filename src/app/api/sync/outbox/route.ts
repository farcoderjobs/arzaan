import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden, badRequest, success } from "@/lib/api";
import { listPendingRows, listRowsByStatus, type OutboxStatus } from "@/lib/sync/outbox";

/**
 * GET /api/sync/outbox — the node's queue of changes waiting for the center.
 *
 * Every row is persisted in the local database, so it survives refreshes,
 * browser restarts, app restarts and a crashed sync. `?status=` filters by row
 * state; without it the endpoint returns everything not yet confirmed.
 */

const STATUSES: OutboxStatus[] = ["PENDING", "SENDING", "SYNCED", "FAILED"];

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const rawStatus = new URL(req.url).searchParams.get("status")?.trim().toUpperCase();
    if (rawStatus && !STATUSES.includes(rawStatus as OutboxStatus)) {
      return NextResponse.json(badRequest("Unknown status filter"), { status: 400 });
    }

    const rows = rawStatus
      ? await listRowsByStatus(rawStatus as OutboxStatus, 200)
      : await listPendingRows(200);

    return NextResponse.json(
      success({
        rows: rows.map((row) => ({
          rowKey: row.rowKey,
          collection: row.collectionName,
          docId: row.docId,
          entityType: row.entityType,
          operation: row.operation,
          status: row.status,
          attempts: row.attempts,
          lastError: row.lastError,
          nextAttemptAt: row.nextAttemptAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          syncedAt: row.syncedAt,
        })),
      }),
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    console.error("GET /api/sync/outbox error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
