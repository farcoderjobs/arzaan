import type { ISyncOutboxDocument } from "@/models";
import { getModelForCollection } from "./registry";
import { policyFor, stripForSync } from "./policy";

/**
 * Turns outbox markers into pushable operations.
 *
 * Markers are dirty flags, so this is where a document's CURRENT state is read
 * from the shop's local database. Rows for the same document collapse into one
 * operation, and the operation's direction is derived from reality:
 *
 *   document exists  → upsert its latest state
 *   document missing → delete it at the center
 *
 * A document created and deleted again therefore becomes a single harmless
 * delete instead of a create followed by a delete.
 */

export type PushOperation = {
  /** Idempotency key the center dedupes on. */
  rowKey: string;
  /** Every outbox row this operation covers (all marked synced together). */
  rowKeys: string[];
  collection: string;
  docId: string;
  operation: "upsert" | "delete";
  entityType: string;
  actorUserId: string | null;
  branchId: string | null;
  /** ISO timestamp used by the center's stale-overwrite guard. */
  docVersion: string | null;
  /** Failed pushes so far for this document — drives the retry backoff. */
  attempts: number;
  doc: Record<string, unknown> | null;
};

export type UnsupportedRow = {
  row: ISyncOutboxDocument;
  collection: string;
};

export type BuildResult = {
  operations: PushOperation[];
  unsupported: UnsupportedRow[];
};

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

/**
 * Reads a document's current state from the shop database. Injectable so the
 * collapsing/direction logic can be unit-tested without a database.
 */
export type DocumentFetcher = (
  collection: string,
  docId: string
) => Promise<Record<string, unknown> | null>;

const defaultFetcher: DocumentFetcher = async (collection, docId) => {
  const model = getModelForCollection(collection);
  if (!model) return null;
  const raw = await model.findById(docId).lean();
  return raw ? (raw as unknown as Record<string, unknown>) : null;
};

export async function buildPushOperations(
  rows: ISyncOutboxDocument[],
  fetchDoc: DocumentFetcher = defaultFetcher
): Promise<BuildResult> {
  // `fetchDoc` replaces the model lookup; `getModelForCollection` is still used
  // to reject collections the center does not accept at all.
  const groups = new Map<string, ISyncOutboxDocument[]>();
  const unsupported: UnsupportedRow[] = [];

  for (const row of rows) {
    if (!policyFor(row.collectionName) || !getModelForCollection(row.collectionName)) {
      unsupported.push({ row, collection: row.collectionName });
      continue;
    }
    const key = `${row.collectionName}\u0000${row.docId}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const operations: PushOperation[] = [];
  for (const group of groups.values()) {
    const [first] = group;
    const raw = await fetchDoc(first.collectionName, first.docId);
    const doc = raw ? { ...raw } : null;
    if (doc) {
      delete doc.__v;
      doc._id = first.docId;
    }

    // Actor attribution: the newest marker with a known actor wins, so a change
    // is always attributed to the user whose action produced it last.
    const actorRow = group.find((row) => row.actorUserId);
    const branchRow = group.find((row) => row.branchId);
    const versions = group
      .map((row) => toIso(row.docVersion))
      .filter((value): value is string => Boolean(value))
      .sort();

    operations.push({
      rowKey: first.rowKey,
      rowKeys: group.map((row) => row.rowKey),
      collection: first.collectionName,
      docId: first.docId,
      operation: doc ? "upsert" : "delete",
      entityType: first.entityType || policyFor(first.collectionName)?.entityType || first.collectionName,
      actorUserId: actorRow?.actorUserId ? String(actorRow.actorUserId) : null,
      branchId: branchRow?.branchId ? String(branchRow.branchId) : null,
      docVersion: versions.length > 0 ? versions[versions.length - 1] : null,
      attempts: group.reduce((max, row) => Math.max(max, row.attempts ?? 0), 0),
      doc: doc ? stripForSync(doc, first.collectionName) : null,
    });
  }

  return { operations, unsupported };
}
