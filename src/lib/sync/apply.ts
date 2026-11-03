import mongoose from "mongoose";
import { SyncAppliedOp, User } from "@/models";
import type { ISyncNodeDocument } from "@/models";
import { getUserPermissions } from "@/lib/authorization";
import { getModelForCollection } from "./registry";
import { policyFor, stripForSync } from "./policy";
import { wasRowApplied } from "./outbox";
import { withoutSyncTracking } from "./tracking";

/**
 * Applies rows pushed by a shop node onto the center's database.
 *
 * Guarantees, per row:
 *  - at-most-once: `SyncAppliedOp` records every row that may not run again, so
 *    a replayed batch (or a retried request) can never double-apply a sale,
 *    a payment or a stock movement;
 *  - server-side authorization: the acting user named by the row must still be
 *    active at the center AND still hold a permission the collection requires;
 *    permissions cached by the shop are never trusted;
 *  - no silent data loss: a refused row comes back as a conflict, the node
 *    keeps the original document and a human decides;
 *  - no stale clobbering: for reference data the center wins when its copy is
 *    newer than the node's change;
 *  - atomicity: each row is a single-document upsert, which MongoDB applies
 *    atomically, so a partial batch cannot half-write one document.
 *
 * Nothing here mutates the shop: the node only learns outcomes.
 */

export type PushedRow = {
  rowKey: string;
  collection: string;
  docId: string;
  operation: "upsert" | "delete";
  entityType?: string | null;
  actorUserId?: string | null;
  branchId?: string | null;
  docVersion?: string | null;
  doc?: Record<string, unknown> | null;
};

export type RowOutcomeStatus = "applied" | "duplicate" | "conflict" | "error";

export type RowOutcome = {
  rowKey: string;
  status: RowOutcomeStatus;
  code?: string;
  message?: string;
};

function conflict(rowKey: string, code: string, message: string): RowOutcome {
  return { rowKey, status: "conflict", code, message };
}

type ActorCheck =
  | { ok: true; permissions: Set<string> | null }
  | { ok: false; code: string; message: string };

async function checkActor(
  row: PushedRow,
  required: string[],
  cache: Map<string, ActorCheck>
): Promise<ActorCheck> {
  if (!row.actorUserId) {
    return {
      ok: false,
      code: "PERMISSION_DENIED",
      message: "No acting user was recorded for this change",
    };
  }

  const cached = cache.get(row.actorUserId);
  if (cached) return cached;

  let result: ActorCheck;
  if (!mongoose.Types.ObjectId.isValid(row.actorUserId)) {
    result = { ok: false, code: "PERMISSION_DENIED", message: "Unknown acting user" };
  } else {
    const user = await User.findById(row.actorUserId).select("_id roleId status").lean();
    if (!user || user.status !== "active") {
      // Deactivated (or removed) users keep their pending financial data — the
      // row is refused, never dropped, and the shop shows it for intervention.
      result = {
        ok: false,
        code: "PERMISSION_DENIED",
        message: "The acting user is no longer active at the center",
      };
    } else {
      const permissions = await getUserPermissions(String(user._id), String(user.roleId));
      if (required.length > 0 && !required.some((permission) => permissions.has(permission))) {
        result = {
          ok: false,
          code: "PERMISSION_DENIED",
          message: `The acting user no longer holds ${required.join(" or ")}`,
        };
      } else {
        result = { ok: true, permissions };
      }
    }
  }

  cache.set(row.actorUserId, result);
  return result;
}

export async function applyPushedRows(
  node: ISyncNodeDocument,
  rows: PushedRow[]
): Promise<RowOutcome[]> {
  // The center must not queue what a node just sent: dirty-marking the applied
  // document would push it straight back to the node's own outbox (an infinite
  // echo on a process that is both node and center) and would also destroy the
  // "applied once" guarantee of the idempotency ledger.
  return withoutSyncTracking(() => applyRows(node, rows));
}

async function applyRows(
  node: ISyncNodeDocument,
  rows: PushedRow[]
): Promise<RowOutcome[]> {
  const outcomes: RowOutcome[] = [];
  const actorCache = new Map<string, ActorCheck>();
  const nodeId = node.nodeId;

  for (const row of rows) {
    try {
      const policy = policyFor(row.collection);
      const model = getModelForCollection(row.collection);
      if (!policy || !model) {
        outcomes.push(
          conflict(row.rowKey, "UNSUPPORTED", `Collection "${row.collection}" is not replicated`)
        );
        continue;
      }
      if (!mongoose.Types.ObjectId.isValid(row.docId)) {
        outcomes.push(conflict(row.rowKey, "VALIDATION", "Invalid document id"));
        continue;
      }

      if (await wasRowApplied(nodeId, row.rowKey)) {
        outcomes.push({ rowKey: row.rowKey, status: "duplicate" });
        continue;
      }

      const actor = await checkActor(row, policy.permissions, actorCache);
      if (!actor.ok) {
        outcomes.push(conflict(row.rowKey, actor.code, actor.message));
        continue;
      }

      const _id = new mongoose.Types.ObjectId(row.docId);
      const existing = await model.findById(_id).select("updatedAt").lean();

      if (row.operation === "delete") {
        if (policy.centerAuthoritative) {
          outcomes.push(
            conflict(
              row.rowKey,
              "UNSUPPORTED",
              "The center keeps reference data — deactivate the record instead of deleting it"
            )
          );
          continue;
        }
        if (existing) await model.deleteOne({ _id });
        await recordApplied(nodeId, row, "delete");
        outcomes.push({ rowKey: row.rowKey, status: "applied" });
        continue;
      }

      const incoming = row.doc ? stripForSync({ ...row.doc }, row.collection) : null;
      if (!incoming) {
        outcomes.push(conflict(row.rowKey, "VALIDATION", "The row carried no document"));
        continue;
      }
      delete incoming._id;

      if (existing && policy.appendOnly) {
        // History is immutable: the center already has this record.
        await recordApplied(nodeId, row, "duplicate");
        outcomes.push({ rowKey: row.rowKey, status: "duplicate" });
        continue;
      }

      if (existing && policy.centerAuthoritative && row.docVersion) {
        const existingUpdatedAt = (existing as { updatedAt?: Date }).updatedAt;
        const incomingVersion = new Date(row.docVersion);
        if (
          existingUpdatedAt instanceof Date &&
          !Number.isNaN(incomingVersion.getTime()) &&
          existingUpdatedAt.getTime() > incomingVersion.getTime()
        ) {
          outcomes.push(
            conflict(
              row.rowKey,
              "STALE_OVERWRITE",
              "The center holds a newer version of this record"
            )
          );
          continue;
        }
      }

      await model.updateOne(
        { _id },
        { $set: incoming },
        { upsert: true, timestamps: false, strict: false }
      );
      await recordApplied(nodeId, row, "applied");
      outcomes.push({ rowKey: row.rowKey, status: "applied" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[sync] applying ${row.collection}:${row.docId} failed`, err);
      outcomes.push({ rowKey: row.rowKey, status: "error", code: "SERVER_ERROR", message });
    }
  }

  return outcomes;
}

async function recordApplied(
  nodeId: string,
  row: PushedRow,
  outcome: "applied" | "delete" | "duplicate"
): Promise<void> {
  await SyncAppliedOp.updateOne(
    { nodeId, rowKey: row.rowKey },
    {
      $setOnInsert: {
        nodeId,
        rowKey: row.rowKey,
        collection: row.collection,
        docId: row.docId,
        outcome,
        appliedAt: new Date(),
      },
    },
    { upsert: true }
  );
}
