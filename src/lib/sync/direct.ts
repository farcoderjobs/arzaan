import mongoose from "mongoose";
import { envSchema } from "@/config/env";
import { SYNC_PULL_COLLECTIONS } from "./collections";
import { applyDeltas, type PullSummary } from "./pull";
import { getState, setState } from "./outbox";
import type { PushOperation } from "./payload";

/**
 * Direct transport: shop MongoDB → online MongoDB, without a deployed "center"
 * app in between.
 *
 * The HTTP transport (`push.ts`/`pull.ts`) assumes a second deployment of this
 * app hosting the online database. A single-PC shop typically has no such
 * deployment — it has this app and an Atlas cluster. In that setup the online
 * database is already reachable from this process via `MONGODB_URI`, so the
 * outbox is applied to it directly:
 *
 *  - each row is upserted by `_id` (the local document is the system of record),
 *  - `syncappliedops` on the online database records `(nodeId, rowKey)` so a
 *    replayed batch can never apply a sale or payment twice,
 *  - reference data is pulled back with the same delta cursors the HTTP pull
 *    uses, so an interrupted pull resumes where it stopped.
 *
 * What this transport does NOT do: re-authorize the acting user against the
 * center (there is no center process) and the stale-overwrite guard. The local
 * database is the shop's own system of record, so the push direction is
 * authoritative; that trade-off is documented in docs/OFFLINE.md.
 */

const CONNECT_TIMEOUT_MS = 15_000;

type OnlineGlobal = { __posOnlineConnection?: Promise<mongoose.Connection> };
const globals = globalThis as typeof globalThis & OnlineGlobal;

type OnlineDb = NonNullable<mongoose.Connection["db"]>;

export type DirectRowResult = {
  rowKey: string;
  status: "applied" | "duplicate" | "error";
  code?: string;
  message?: string;
};

export function isDirectTransportConfigured(): boolean {
  return true;
}

/** The process-wide connection to the online database (never the default one). */
async function onlineDb(): Promise<OnlineDb> {
  if (!globals.__posOnlineConnection) {
    const env = envSchema.parse(process.env);
    const connection = mongoose.createConnection(env.MONGODB_URI, {
      dbName: env.MONGODB_DB_NAME,
      maxPoolSize: 5,
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    });
    globals.__posOnlineConnection = connection
      .asPromise()
      .then(() => connection)
      .catch((err) => {
        globals.__posOnlineConnection = undefined;
        throw err;
      });
  }

  const connection = await (globals.__posOnlineConnection as Promise<mongoose.Connection>);
  if (!connection.db) throw new Error("The online database connection closed");
  return connection.db;
}

/**
 * Applies one batch of outbox operations to the online database.
 *
 * Returns the same per-row vocabulary the HTTP center uses, so `push.ts` can
 * mark rows synced, retry or conflict identically for both transports.
 */
export async function pushDirect(
  operations: PushOperation[],
  nodeId: string
): Promise<DirectRowResult[]> {
  const db = await onlineDb();
  const ledger = db.collection("syncappliedops");
  await ledger.createIndex({ nodeId: 1, rowKey: 1 }, { unique: true }).catch(() => undefined);

  const results: DirectRowResult[] = [];

  for (const op of operations) {
    try {
      const already = await ledger.findOne({ nodeId, rowKey: op.rowKey }, { projection: { _id: 1 } });
      if (already) {
        results.push({ rowKey: op.rowKey, status: "duplicate" });
        continue;
      }

      if (!mongoose.Types.ObjectId.isValid(op.docId)) {
        results.push({ rowKey: op.rowKey, status: "error", message: "Invalid document id" });
        continue;
      }
      const _id = new mongoose.Types.ObjectId(op.docId);

      if (op.operation === "delete") {
        await db.collection(op.collection).deleteOne({ _id });
      } else {
        if (!op.doc) {
          results.push({ rowKey: op.rowKey, status: "error", message: "Missing document body" });
          continue;
        }
        const document: Record<string, unknown> = { ...op.doc, _id };
        delete document.__v;
        await db.collection(op.collection).replaceOne({ _id }, document, { upsert: true });
      }

      const now = new Date();
      await ledger.updateOne(
        { nodeId, rowKey: op.rowKey },
        {
          $setOnInsert: {
            nodeId,
            rowKey: op.rowKey,
            collectionName: op.collection,
            docId: op.docId,
            outcome: "applied",
            appliedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true }
      );

      results.push({ rowKey: op.rowKey, status: "applied" });
    } catch (err) {
      results.push({
        rowKey: op.rowKey,
        status: "error",
        message: err instanceof Error ? err.message : "Write failed",
      });
    }
  }

  return results;
}

/**
 * Pulls reference-data deltas straight from the online database.
 *
 * Same rules as the HTTP pull: a document with an unsent local edit is skipped
 * (the shop's change wins until it is pushed), and writes are applied with
 * tracking suppressed so they cannot echo back.
 */
export async function pullDirect(): Promise<PullSummary> {
  let db: OnlineDb;
  try {
    db = await onlineDb();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Online database unreachable";
    await setState("pull.lastError", { at: new Date().toISOString(), message });
    return { configured: true, reachable: false, applied: 0, message };
  }

  let applied = 0;

  try {
    for (const collection of SYNC_PULL_COLLECTIONS) {
      const cursor = await getState<string | null>(`pull.cursor.${collection}`, null);
      const since = cursor && !Number.isNaN(new Date(cursor).getTime()) ? new Date(cursor) : new Date(0);

      const docs = await db
        .collection(collection)
        .find({ updatedAt: { $gt: since } })
        .sort({ updatedAt: 1 })
        .limit(500)
        .toArray();

      if (docs.length === 0) continue;

      applied += await applyDeltas({ docs: { [collection]: docs } });

      const newest = docs.reduce<Date>((max, doc) => {
        const updatedAt = doc.updatedAt instanceof Date ? doc.updatedAt : new Date(doc.updatedAt as string);
        return updatedAt.getTime() > max.getTime() ? updatedAt : max;
      }, since);
      await setState(`pull.cursor.${collection}`, newest.toISOString());
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Pull failed";
    await setState("pull.lastError", { at: new Date().toISOString(), message });
    return { configured: true, reachable: false, applied, message };
  }

  await setState("pull.lastSuccessAt", new Date().toISOString());
  await setState("pull.lastError", null);

  return {
    configured: true,
    reachable: true,
    applied,
    message: `${applied} record${applied === 1 ? "" : "s"} pulled`,
  };
}
