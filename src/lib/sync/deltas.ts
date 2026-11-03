import mongoose from "mongoose";
import type { ISyncNodeDocument } from "@/models";
import { SYNC_PULL_COLLECTIONS } from "./collections";
import { getModelForCollection } from "./registry";
import { stripForSync } from "./policy";

/**
 * Center-side delta collection for a pulling node.
 *
 * Reference data only (catalogue, customers, suppliers, users, roles,
 * settings). Transactional history is push-only, so this can never overwrite a
 * sale.
 *
 * A node bound to a branch (`SyncNode.branchId`) receives that branch's records
 * plus the shared (branch-less) ones; an unbound node receives everything.
 */

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2_000;

export type PullBatch = {
  docs: Record<string, Array<Record<string, unknown>>>;
  cursors: Record<string, string>;
  hasMore: boolean;
  counts: Record<string, number>;
};

function branchCondition(node: ISyncNodeDocument): Record<string, unknown> {
  if (!node.branchId) return {};
  return {
    $or: [
      { branchId: node.branchId },
      { branchId: null },
      { branchId: { $exists: false } },
    ],
  };
}

export async function collectDeltas(
  node: ISyncNodeDocument,
  cursors: Record<string, string | undefined>,
  requestedLimit?: number
): Promise<PullBatch> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, requestedLimit ?? DEFAULT_LIMIT));
  const docs: PullBatch["docs"] = {};
  const nextCursors: Record<string, string> = {};
  const counts: Record<string, number> = {};
  let hasMore = false;

  for (const collection of SYNC_PULL_COLLECTIONS) {
    const model = getModelForCollection(collection);
    if (!model) continue;

    const sinceRaw = cursors[collection];
    const since = sinceRaw && !Number.isNaN(new Date(sinceRaw).getTime())
      ? new Date(sinceRaw)
      : new Date(0);

    const rows = await model
      .find({ ...branchCondition(node), updatedAt: { $gt: since } })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean();

    docs[collection] = rows.map((row) =>
      stripForSync({ ...(row as unknown as Record<string, unknown>) }, collection)
    );
    counts[collection] = rows.length;
    if (rows.length >= limit) hasMore = true;

    if (rows.length > 0) {
      const newest = rows.reduce<Date>((max, row) => {
        const updatedAt = (row as { updatedAt?: Date }).updatedAt;
        if (!(updatedAt instanceof Date)) return max;
        return updatedAt.getTime() > max.getTime() ? updatedAt : max;
      }, since);
      nextCursors[collection] = newest.toISOString();
    } else {
      nextCursors[collection] = since.toISOString();
    }
  }

  return { docs, cursors: nextCursors, hasMore, counts };
}

export function parseCursors(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  return out;
}

export const PULL_COLLECTIONS = SYNC_PULL_COLLECTIONS;

/** Only these collections may be written by a pull on the node. */
export function isPullableCollection(collection: string): boolean {
  return SYNC_PULL_COLLECTIONS.includes(collection);
}

export function isValidObjectId(value: string): boolean {
  return mongoose.Types.ObjectId.isValid(value);
}
