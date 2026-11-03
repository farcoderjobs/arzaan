import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, notFound, success } from "@/lib/api";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import {
  deleteConflictRow,
  listConflicts,
  requeueFailedRows,
  resolveConflictRow,
} from "@/lib/sync/outbox";

/**
 * Sync conflicts — changes the center refused.
 *
 * GET returns the open conflicts with the local document snapshot, so nothing
 * is ever lost when a push is rejected. POST either
 *
 *  - `retry`   → clear the conflict and put the row back in the queue (after
 *                the cause is fixed: the user was reactivated, the center's
 *                copy was corrected, …), or
 *  - `dismiss` → set the row aside deliberately, recording who decided and why.
 *
 * Neither action deletes the shop's document: the local database remains the
 * system of record for the shop.
 */

const resolveSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("retry"),
    conflictKey: z.string().min(8).max(200),
  }),
  z.object({
    action: z.literal("dismiss"),
    conflictKey: z.string().min(8).max(200),
    reason: z.string().min(3).max(300),
  }),
]);

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const includeResolved = new URL(req.url).searchParams.get("all") === "1";
    const conflicts = await listConflicts({ includeResolved, limit: 200 });

    return NextResponse.json(
      success({
        conflicts: conflicts.map((row) => ({
          conflictKey: row.conflictKey,
          rowKey: row.rowKey,
          collection: row.collectionName,
          docId: row.docId,
          entityType: row.entityType,
          kind: row.kind,
          message: row.message,
          retryable: row.retryable,
          resolved: row.resolved,
          resolution: row.resolution,
          payload: row.payload ?? null,
          createdAt: row.createdAt,
          resolvedAt: row.resolvedAt,
        })),
      }),
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    console.error("GET /api/sync/conflicts error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    const body = await req.json().catch(() => null);
    const parsed = resolveSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed"), { status: 400 });
    }

    const meta = requestMeta(req);
    const payload = parsed.data;

    // Retrying re-queues a financial or catalogue change → sales.create.
    // Setting one aside is an administrative decision → settings.manage.
    const permission =
      payload.action === "retry" ? PERMISSIONS.sales.create : PERMISSIONS.settings.manage;
    if (!(await hasPermission(user, permission))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const conflicts = await listConflicts({ includeResolved: true, limit: 500 });
    const conflict = conflicts.find((row) => row.conflictKey === payload.conflictKey);
    if (!conflict) return NextResponse.json(notFound("Conflict not found"), { status: 404 });

    if (payload.action === "retry") {
      await resolveConflictRow(conflict.conflictKey, "Requeued for retry", user.id, true);
      await recordAuditLog({
        user,
        action: "sync.conflict_retry",
        entityType: "SyncConflict",
        entityId: conflict.docId,
        branchId: user.branchId,
        note: `Requeued ${conflict.collectionName}:${conflict.docId}`,
        ...meta,
      });
      return NextResponse.json(success({ conflictKey: conflict.conflictKey }, "Change requeued"));
    }

    await resolveConflictRow(conflict.conflictKey, payload.reason, user.id, false);
    await recordAuditLog({
      user,
      action: "sync.conflict_dismiss",
      entityType: "SyncConflict",
      entityId: conflict.docId,
      branchId: user.branchId,
      note: `Set aside ${conflict.collectionName}:${conflict.docId} — ${payload.reason}`,
      ...meta,
    });
    return NextResponse.json(success({ conflictKey: conflict.conflictKey }, "Conflict set aside"));
  } catch (error) {
    console.error("POST /api/sync/conflicts error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.settings.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }
    const { conflictKey } = (await req.json().catch(() => ({}))) as { conflictKey?: string };
    if (!conflictKey) return NextResponse.json(badRequest("conflictKey is required"), { status: 400 });

    await deleteConflictRow(conflictKey);
    return NextResponse.json(success(null, "Conflict record removed"));
  } catch (error) {
    console.error("DELETE /api/sync/conflicts error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Requeues every FAILED outbox row (Retry all). */
export async function PUT(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.create))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const requeued = await requeueFailedRows();
    await recordAuditLog({
      user,
      action: "sync.requeue_all",
      entityType: "SyncConflict",
      entityId: null,
      branchId: user.branchId,
      note: `${requeued} failed row(s) requeued`,
      ...requestMeta(req),
    });

    return NextResponse.json(success({ requeued }, `${requeued} change(s) requeued`));
  } catch (error) {
    console.error("PUT /api/sync/conflicts error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
