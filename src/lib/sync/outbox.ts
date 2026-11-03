import mongoose from "mongoose";
import { SyncOutbox, SyncConflict, SyncRun, SyncState, SyncAppliedOp } from "@/models";
import type { ISyncOutboxDocument, SyncConflictKind } from "@/models";
import { isDue, newRowKey, nextAttemptAt } from "./backoff";
import { policyFor, priorityFor } from "./policy";
import { getModelForCollection, trackedCollectionNames } from "./registry";

/**
 * The node's outbox.
 *
 * A row is a DIRTY MARKER, not a payload: it says "this document changed and
 * must reach the center". The worker materialises the document's current state
 * from the local database when it pushes, which means
 *
 *  - a document edited twice before a sync is replicated once, in its final
 *    form, and
 *  - a document created and deleted again collapses into a delete.
 *
 * Rows are never removed when a push fails: they stay (with backoff, or FAILED
 * with a preserved payload) until the center confirms persistence.
 */

export type DirtyOperation = "upsert" | "delete";

export type DirtyMarker = {
  collection: string;
  docId: string;
  operation: DirtyOperation;
  actorUserId?: string | null;
  branchId?: string | null;
  /** `updatedAt` of the document when it was marked dirty (staleness guard). */
  docVersion?: Date | null;
  session?: mongoose.ClientSession | null;
};

const STUCK_SENDING_MS = 5 * 60 * 1000;

/**
 * A row must be this old before it can be pushed.
 *
 * Financial writes mark their documents dirty from inside a Mongo transaction,
 * so a push that raced the commit could read a document that is not visible yet
 * and, for an insert, conclude "it does not exist → send a delete". Waiting a
 * few seconds costs nothing and removes that race entirely.
 */
export const MIN_ROW_AGE_MS = 3_000;

/**
 * Records (or refreshes) the pending row for a document.
 *
 * Never throws into the caller's business flow: losing a marker must not fail a
 * sale. The failure is logged and surfaced by the Sync Center's reconciliation
 * action, which re-marks every document for a full re-push.
 */
export async function markDirty(marker: DirtyMarker): Promise<void> {
  const policy = policyFor(marker.collection);
  if (!policy) return;

  try {
    const session = marker.session ?? null;
    await SyncOutbox.updateOne(
      { collectionName: marker.collection, docId: marker.docId, status: "PENDING" },
      {
        $set: {
          operation: marker.operation,
          priority: priorityFor(marker.collection),
          entityType: policy.entityType,
          attempts: 0,
          nextAttemptAt: Date.now(),
          lastError: null,
          ...(marker.actorUserId ? { actorUserId: new mongoose.Types.ObjectId(marker.actorUserId) } : {}),
          ...(marker.branchId ? { branchId: new mongoose.Types.ObjectId(marker.branchId) } : {}),
          docVersion: marker.docVersion ?? new Date(),
          syncedAt: null,
        },
        $setOnInsert: { rowKey: newRowKey() },
      },
      { upsert: true, ...(session ? { session } : {}) }
    );
  } catch (err) {
    console.error(
      `[sync] could not queue ${marker.collection}:${marker.docId} for replication`,
      err
    );
    await recordTrackingFailure(err).catch(() => undefined);
  }
}

/** Marks every document of every tracked collection dirty (full re-push). */
export async function markAllDirty(): Promise<number> {
  let marked = 0;
  for (const collection of trackedCollectionNames()) {
    const model = getModelForCollection(collection);
    if (!model) continue;
    const rows = await model.find({}).select("_id updatedAt").lean();
    for (const row of rows) {
      await markDirty({
        collection,
        docId: String(row._id),
        operation: "upsert",
        docVersion: (row as { updatedAt?: Date }).updatedAt ?? new Date(),
      });
      marked += 1;
    }
  }
  return marked;
}

/**
 * Rows that are due for a push, oldest-first inside each dependency band so a
 * sale never reaches the center before the product/customer it references.
 */
export async function listDueRows(options: { force?: boolean; limit?: number } = {}) {
  const now = Date.now();
  const filter: Record<string, unknown> = {
    status: { $in: ["PENDING", "SENDING"] },
    updatedAt: { $lte: new Date(now - MIN_ROW_AGE_MS) },
  };
  if (!options.force) filter.nextAttemptAt = { $lte: now };
  const rows = await SyncOutbox.find(filter)
    .sort({ priority: 1, createdAt: 1 })
    .limit(options.limit ?? 500)
    .lean();
  // A `force` run (Sync now) skips the backoff window but still respects it for
  // rows another worker just failed.
  return options.force ? rows : rows.filter((row) => isDue(row, now));
}

/** Every row still waiting to reach the center. */
export async function listPendingRows(limit = 500) {
  return SyncOutbox.find({ status: { $in: ["PENDING", "SENDING", "FAILED"] } })
    .sort({ priority: 1, createdAt: 1 })
    .limit(limit)
    .lean();
}

export type OutboxStatus = ISyncOutboxDocument["status"];

export async function listRowsByStatus(status: OutboxStatus, limit = 200) {
  return SyncOutbox.find({ status }).sort({ createdAt: -1 }).limit(limit).lean();
}

export async function outboxCounts(): Promise<{
  pending: number;
  sending: number;
  failed: number;
  synced: number;
}> {
  const [pending, sending, failed, synced] = await Promise.all([
    SyncOutbox.countDocuments({ status: "PENDING" }),
    SyncOutbox.countDocuments({ status: "SENDING" }),
    SyncOutbox.countDocuments({ status: "FAILED" }),
    SyncOutbox.countDocuments({ status: "SYNCED" }),
  ]);
  return { pending, sending, failed, synced };
}

/** Flags rows as in-flight so the UI can distinguish "queued" from "being sent". */
export async function claimRows(rowKeys: string[]): Promise<number> {
  if (rowKeys.length === 0) return 0;
  // `timestamps: false`: bookkeeping must not touch `updatedAt`. That field is
  // the "dirty since" clock the push grace window uses, so bumping it here (or
  // on a retry) would make the row un-pushable for another whole grace period
  // after every attempt — a manual "Sync now" right after a failed run would
  // find "nothing to push" while the queue is full.
  const res = await SyncOutbox.updateMany(
    { rowKey: { $in: rowKeys }, status: "PENDING" },
    { $set: { status: "SENDING", claimedAt: new Date() } },
    { timestamps: false }
  );
  return res.modifiedCount ?? 0;
}

/** Marks the given rows as successfully persisted on the center. */
export async function markRowsSynced(rowKeys: string[]): Promise<number> {
  if (rowKeys.length === 0) return 0;
  const res = await SyncOutbox.updateMany(
    { rowKey: { $in: rowKeys } },
    { $set: { status: "SYNCED", syncedAt: new Date(), lastError: null, claimedAt: null } },
    { timestamps: false }
  );
  return res.modifiedCount ?? 0;
}

/**
 * Marks every pending row for a document as synced. One pushed operation covers
 * all of them, because each row describes the same (dirtied) document.
 */
export async function markDocRowsSynced(collection: string, docId: string): Promise<number> {
  const res = await SyncOutbox.updateMany(
    { collectionName: collection, docId, status: { $in: ["PENDING", "SENDING"] } },
    { $set: { status: "SYNCED", syncedAt: new Date(), lastError: null, claimedAt: null } },
    { timestamps: false }
  );
  return res.modifiedCount ?? 0;
}

/** Transient failure — back off and try again. The row keeps its place. */
export async function scheduleRowRetry(
  row: Pick<ISyncOutboxDocument, "rowKey" | "attempts">,
  message: string
): Promise<void> {
  const attempts = (row.attempts ?? 0) + 1;
  await SyncOutbox.updateOne(
    { rowKey: row.rowKey },
    {
      $set: {
        status: "PENDING",
        attempts,
        lastError: message.slice(0, 500),
        nextAttemptAt: nextAttemptAt(attempts, Date.now()),
        claimedAt: null,
      },
    },
    { timestamps: false }
  );
}

/**
 * Permanent failure. The row stops auto-retrying (a human decides), the original
 * document snapshot is preserved in a conflict row, and nothing is discarded.
 */
export async function failRow(
  row: Pick<ISyncOutboxDocument, "rowKey" | "attempts" | "collectionName" | "docId" | "entityType">,
  kind: SyncConflictKind,
  message: string,
  options: { retryable?: boolean; payload?: unknown; nodeId?: string } = {}
): Promise<void> {
  await SyncOutbox.updateOne(
    { rowKey: row.rowKey },
    {
      $set: {
        status: "FAILED",
        attempts: (row.attempts ?? 0) + 1,
        lastError: `${kind}: ${message}`.slice(0, 500),
        // Manual attention required — never auto-scheduled.
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        claimedAt: null,
      },
    },
    { timestamps: false }
  );

  await SyncConflict.updateOne(
    { conflictKey: row.rowKey },
    {
      $set: {
        rowKey: row.rowKey,
        collectionName: row.collectionName,
        docId: row.docId,
        entityType: row.entityType ?? "",
        kind,
        message: message.slice(0, 500),
        retryable: options.retryable ?? kind !== "UNSUPPORTED",
        resolved: false,
        nodeId: options.nodeId ?? "",
        ...(options.payload !== undefined ? { payload: options.payload } : {}),
      },
      $setOnInsert: { conflictKey: row.rowKey },
    },
    { upsert: true }
  );
}

/** Rows left in SENDING by a crash/interrupted sync go back to PENDING. */
export async function resetStuckRows(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_SENDING_MS);
  const res = await SyncOutbox.updateMany(
    {
      status: "SENDING",
      // Rows claimed by this build carry `claimedAt`; legacy rows fall back to
      // `updatedAt`, which older builds bumped on every claim.
      $or: [{ claimedAt: { $lt: cutoff } }, { claimedAt: null, updatedAt: { $lt: cutoff } }],
    },
    { $set: { status: "PENDING", nextAttemptAt: Date.now(), claimedAt: null } },
    { timestamps: false }
  );
  return res.modifiedCount ?? 0;
}

/** Requeues FAILED rows (Retry / Retry all in the Sync Center). */
export async function requeueFailedRows(rowKeys?: string[]): Promise<number> {
  const filter: Record<string, unknown> = { status: "FAILED" };
  if (rowKeys && rowKeys.length > 0) filter.rowKey = { $in: rowKeys };
  const res = await SyncOutbox.updateMany(
    filter,
    { $set: { status: "PENDING", nextAttemptAt: Date.now(), claimedAt: null } },
    { timestamps: false }
  );
  return res.modifiedCount ?? 0;
}

/** Keeps the outbox small: synced rows are history, not a ledger. */
export async function pruneSyncedRows(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const res = await SyncOutbox.deleteMany({ status: "SYNCED", syncedAt: { $lt: cutoff } });
  return res.deletedCount ?? 0;
}

/* ------------------------------ conflicts ------------------------------ */

export async function listConflicts(options: { includeResolved?: boolean; limit?: number } = {}) {
  const filter = options.includeResolved ? {} : { resolved: false };
  return SyncConflict.find(filter).sort({ createdAt: -1 }).limit(options.limit ?? 200).lean();
}

export async function countOpenConflicts(): Promise<number> {
  return SyncConflict.countDocuments({ resolved: false });
}

export async function resolveConflictRow(
  conflictKey: string,
  resolution: string,
  userId: string | null,
  alsoRequeue: boolean
): Promise<void> {
  await SyncConflict.updateOne(
    { conflictKey },
    {
      $set: {
        resolved: true,
        resolution: resolution.slice(0, 300),
        resolvedBy: userId ? new mongoose.Types.ObjectId(userId) : null,
        resolvedAt: new Date(),
      },
    }
  );
  if (alsoRequeue) {
    await requeueFailedRows([conflictKey]);
  }
}

/** One conflict per failed row — removing the row removes its conflict. */
export async function deleteConflictRow(conflictKey: string): Promise<void> {
  await SyncConflict.deleteOne({ conflictKey });
}

/* -------------------------------- runs -------------------------------- */

export async function startRun(kind: string, nodeId: string): Promise<string> {
  const run = await SyncRun.create([
    { kind, status: "running", startedAt: new Date(), nodeId },
  ]);
  return String(run[0]._id);
}

export async function finishRun(
  runId: string,
  summary: {
    status: "completed" | "failed";
    pushed: number;
    failed: number;
    conflicted: number;
    remaining: number;
    pulled: number;
    message: string;
  }
): Promise<void> {
  await SyncRun.updateOne(
    { _id: runId },
    { $set: { ...summary, finishedAt: new Date() } }
  );
}

export async function listRuns(limit = 10) {
  return SyncRun.find({}).sort({ createdAt: -1 }).limit(limit).lean();
}

/* ------------------------------ sync state ------------------------------ */

export async function getState<T>(key: string, fallback: T): Promise<T> {
  const row = await SyncState.findOne({ key }).lean();
  if (!row || row.value === undefined || row.value === null) return fallback;
  return row.value as T;
}

export async function setState(key: string, value: unknown): Promise<void> {
  await SyncState.updateOne({ key }, { $set: { value } }, { upsert: true });
}

async function recordTrackingFailure(err: unknown): Promise<void> {
  await setState("tracking.lastError", {
    at: new Date().toISOString(),
    message: err instanceof Error ? err.message : String(err),
    reconciliationRequired: true,
  });
}

/* --------------------------- idempotency ledger --------------------------- */

/** True when this node's row was already applied by the center. */
export async function wasRowApplied(nodeId: string, rowKey: string): Promise<boolean> {
  return Boolean(await SyncAppliedOp.exists({ nodeId, rowKey }));
}
