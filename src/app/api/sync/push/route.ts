import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { badRequest, success, unauthorized } from "@/lib/api";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { applyPushedRows } from "@/lib/sync/apply";
import { authenticateNode, touchNode } from "@/lib/sync/node-auth";
import { withoutSyncTracking } from "@/lib/sync/tracking";

/**
 * POST /api/sync/push — ingest a batch of rows from a shop node.
 *
 * Called server-to-server by the node's sync worker, so it authenticates with
 * the node id + secret headers instead of a session cookie. Per-row
 * idempotency, authorization and conflict handling all live in
 * `@/lib/sync/apply`; this route is the transport plus audit.
 *
 * The response is always 200 with per-row outcomes once the request is
 * authenticated: a row the center refuses is a business outcome the node must
 * record (and show a human), not a transport error.
 */

const rowSchema = z.object({
  rowKey: z.string().min(8).max(120),
  collection: z.string().min(1).max(60),
  docId: z.string().min(1).max(64),
  operation: z.enum(["upsert", "delete"]),
  entityType: z.string().max(60).nullish(),
  actorUserId: z.string().max(64).nullish(),
  branchId: z.string().max(64).nullish(),
  docVersion: z.string().max(40).nullish(),
  doc: z.record(z.unknown()).nullish(),
});

const pushSchema = z.object({
  nodeName: z.string().max(120).optional(),
  sentAt: z.string().max(40).optional(),
  rows: z.array(rowSchema).min(1).max(2_000),
});

export async function POST(req: NextRequest) {
  try {
    await connectDB();

    const node = await authenticateNode(req.headers);
    if (!node) {
      return NextResponse.json(
        unauthorized("Invalid or inactive sync node credentials"),
        { status: 401 }
      );
    }

    const parsed = pushSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", {
        rows: parsed.error.errors[0]?.message ?? "Invalid push payload",
      }), { status: 400 });
    }

    const rows = parsed.data.rows;
    const results = await applyPushedRows(node, rows);

    const applied = results.filter((r) => r.status === "applied").length;
    const conflicts = results.filter((r) => r.status === "conflict").length;
    const errors = results.filter((r) => r.status === "error").length;

    await touchNode(node.nodeId, { lastPushAt: new Date(), pushedRows: applied });

    // Center-side audit is bookkeeping, never business data to replicate. A
    // process that is both node and center (one machine, one database — the QA
    // setup and a single-PC install) would otherwise queue the audit of the push
    // it just received, so the shop's outbox could never drain.
    await withoutSyncTracking(() =>
      recordAuditLog({
        action: "sync.push",
        entityType: "SyncNode",
        entityId: node._id.toString(),
        branchId: node.branchId?.toString() ?? null,
        note:
          `node ${node.nodeId} pushed ${rows.length} row(s): ` +
          `${applied} applied, ${conflicts} conflicted, ${errors} errored`,
        newValue: { applied, conflicts, errors, rows: rows.length },
        ...requestMeta(req),
      })
    );

    return NextResponse.json(
      success({ nodeId: node.nodeId, results, appliedAt: new Date().toISOString() })
    );
  } catch (error) {
    console.error("POST /api/sync/push error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
