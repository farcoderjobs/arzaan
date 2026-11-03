import { AsyncLocalStorage } from "node:async_hooks";
import type { Schema } from "mongoose";
import { isTrackingEnabled } from "./config";
import { isTrackedCollection, priorityFor } from "./policy";

/**
 * Dirty-document tracking.
 *
 * `syncTrackingPlugin` is registered on every replicated schema. When the app
 * writes a document, the hook queues a marker in the outbox; the worker reads
 * the document's *current* state when it pushes. Consequences:
 *
 *  - a document edited twice before a push is replicated once, in its final
 *    form (no redundant operations, no lost updates),
 *  - a document created and deleted again collapses into a single delete,
 *  - markers are best-effort and never fail, slow down or roll back the
 *    business write; the Sync Center's reconciliation action re-marks every
 *    document if a marker was ever lost.
 *
 * The acting user is taken from an AsyncLocalStorage context that
 * `requireSessionUser()` establishes for the request. The center re-checks that
 * user's permissions before applying anything — a client's cached permissions
 * are never treated as authorization.
 *
 * This module imports no models (the model layer registers the plugin), so the
 * hook bodies load the outbox lazily.
 */

export type SyncActor = { userId: string | null; branchId: string | null };

type TrackingContext = { suppress: boolean; actor: SyncActor };

/**
 * The store lives on `globalThis` on purpose.
 *
 * The server bundle can instantiate this module more than once (the proxy and
 * each route graph get their own copy of the module registry), and two copies
 * would each own a *different* AsyncLocalStorage: `requireSessionUser()` would
 * set the actor in one instance while the mongoose hooks read the other —
 * silently recording every dirty marker with no acting user. A single shared
 * storage makes every copy see the same context, exactly like the connection
 * cache in `@/lib/mongodb`.
 */
const globals = globalThis as typeof globalThis & {
  __syncTracking?: AsyncLocalStorage<TrackingContext>;
};

globals.__syncTracking ??= new AsyncLocalStorage<TrackingContext>();
const storage = globals.__syncTracking;

/** How many ids a query-shaped write may resolve into markers. */
const MAX_RESOLVED_IDS = 500;

/** Establishes the acting user for the remaining async context of a request. */
export function enterSyncActor(actor: SyncActor): void {
  const current = storage.getStore();
  if (current?.suppress) return; // an explicit suppression always wins
  storage.enterWith({ suppress: false, actor });
}

/**
 * Opens a sync context whose actor starts empty, and returns that actor so the
 * caller can fill it in later.
 *
 * MUST be called synchronously from the caller's own frame — with no `await`
 * before it. `enterWith` only transitions the context that is executing *right
 * now*; if the caller suspends first, the transition lands on the callee's own
 * continuation and the real caller (the route handler) never sees it. Running
 * this in the prologue of an `async` function that the route awaits therefore
 * transitions the route's context, and the object handed back is the one every
 * later continuation inherits — filling it in after the awaits is a mutation of
 * that shared object, not a second transition.
 */
export function beginSyncActor(): SyncActor {
  const actor: SyncActor = { userId: null, branchId: null };
  const current = storage.getStore();
  if (current?.suppress) return actor; // detached: never reaches a store
  storage.enterWith({ suppress: false, actor });
  return actor;
}

export function getSyncActor(): SyncActor | null {
  return storage.getStore()?.actor ?? null;
}

/** Runs `fn` with the given actor (scripts, workers, tests). */
export function runWithSyncActor<T>(actor: SyncActor, fn: () => Promise<T>): Promise<T> {
  return storage.run({ suppress: false, actor }, fn);
}

/**
 * Runs `fn` with tracking suppressed — used when the node applies data that came
 * FROM the center (pull) or reconciles its own state, so those writes cannot
 * echo straight back as new pushes.
 */
export function withoutSyncTracking<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ suppress: true, actor: { userId: null, branchId: null } }, fn);
}

/* ------------------------------- plumbing ------------------------------- */

type DocLike = {
  _id?: unknown;
  updatedAt?: unknown;
  collection?: { name?: string };
};

type ModelLike = { collection?: { name?: string } };

type QueryLike = {
  model?: { collection?: { name?: string }; find: (filter: unknown) => QueryCursorLike };
  getFilter?: () => unknown;
  getOptions?: () => { session?: unknown } | undefined;
};

type QueryCursorLike = {
  select: (fields: string) => QueryCursorLike;
  limit: (n: number) => QueryCursorLike;
  session: (s: unknown) => QueryCursorLike;
  lean: () => Promise<Array<{ _id?: unknown }>>;
};

type MarkerLike = {
  collection: string;
  docId: string;
  operation: "upsert" | "delete";
  actorUserId: string | null;
  branchId: string | null;
  docVersion: Date;
};

let outboxModule: Promise<typeof import("./outbox")> | null = null;

function loadOutbox(): Promise<typeof import("./outbox")> {
  if (!outboxModule) outboxModule = import("./outbox");
  return outboxModule;
}

function trackingActive(): boolean {
  const ctx = storage.getStore();
  if (ctx?.suppress) return false;
  return isTrackingEnabled();
}

function actorFields(): Pick<MarkerLike, "actorUserId" | "branchId"> {
  const actor = storage.getStore()?.actor;
  return { actorUserId: actor?.userId ?? null, branchId: actor?.branchId ?? null };
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date();
}

function queue(marker: MarkerLike): void {
  void loadOutbox()
    .then((mod) => mod.markDirty(marker))
    .catch((err) => {
      console.error(`[sync] could not queue ${marker.collection}:${marker.docId}`, err);
    });
}

function collectionOf(target: DocLike | ModelLike | QueryLike): string | null {
  const name = (target as ModelLike)?.collection?.name;
  return typeof name === "string" ? name : null;
}

/** Ids referenced by a query filter's `_id`, when it names them directly. */
function idsFromFilter(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (Array.isArray(rec.$in)) return rec.$in.map((v) => String(v));
    if (value instanceof Object && "toString" in value) {
      const asString = String(value);
      if (/^[a-f0-9]{24}$/i.test(asString)) return [asString];
    }
  }
  return [];
}

async function resolveIds(query: QueryLike): Promise<string[]> {
  const filter = (query.getFilter?.() ?? {}) as Record<string, unknown>;
  const direct = idsFromFilter(filter._id);
  if (direct.length > 0) return direct.slice(0, MAX_RESOLVED_IDS);

  const { _id: _ignored, ...rest } = filter;
  const cursor = query.model?.find(rest);
  if (!cursor) return [];
  const session = query.getOptions?.()?.session ?? null;
  const rows = await cursor.select("_id").limit(MAX_RESOLVED_IDS).session(session).lean();
  return rows.map((row) => String(row._id)).filter(Boolean);
}

async function queueQueryUpsert(query: QueryLike): Promise<void> {
  if (!trackingActive()) return;
  const collection = collectionOf(query);
  if (!collection || !isTrackedCollection(collection)) return;

  const ids = await resolveIds(query);
  if (ids.length === 0) return;
  const now = new Date();
  const actor = actorFields();
  for (const docId of ids) {
    queue({ collection, docId, operation: "upsert", docVersion: now, ...actor });
  }
}

async function queueQueryDelete(query: QueryLike): Promise<void> {
  if (!trackingActive()) return;
  const collection = collectionOf(query);
  if (!collection || !isTrackedCollection(collection)) return;

  // Deletes must be captured BEFORE the documents disappear.
  const ids = await resolveIds(query);
  if (ids.length === 0) return;
  const now = new Date();
  const actor = actorFields();
  for (const docId of ids) {
    queue({ collection, docId, operation: "delete", docVersion: now, ...actor });
  }
}

/* -------------------------------- plugin -------------------------------- */

const UPDATE_HOOKS = [
  "updateOne",
  "updateMany",
  "replaceOne",
  "findOneAndUpdate",
  "findOneAndReplace",
] as const;

const DELETE_HOOKS = ["deleteOne", "deleteMany", "findOneAndDelete"] as const;

/**
 * Registers the tracking hooks. Applied to every replicated schema in
 * `src/models/index.ts`; collections outside the replication table are ignored
 * at runtime.
 */
export function syncTrackingPlugin(schema: Schema): void {
  schema.post("save", function (this: DocLike) {
    if (!trackingActive()) return;
    const collection = collectionOf(this);
    if (!collection || !isTrackedCollection(collection) || !this._id) return;
    queue({
      collection,
      docId: String(this._id),
      operation: "upsert",
      docVersion: toDate(this.updatedAt),
      ...actorFields(),
    });
  });

  // insertMany bypasses `save`, and its post hook is the first place where the
  // (application-generated) `_id`s exist.
  schema.post("insertMany", function (this: ModelLike, docs: unknown) {
    if (!trackingActive()) return;
    const collection = collectionOf(this);
    if (!collection || !isTrackedCollection(collection)) return;
    const list = Array.isArray(docs) ? docs : [];
    const actor = actorFields();
    for (const entry of list) {
      const doc = entry as DocLike;
      if (!doc || !doc._id) continue;
      queue({
        collection,
        docId: String(doc._id),
        operation: "upsert",
        docVersion: toDate(doc.updatedAt),
        ...actor,
      });
    }
  });

  for (const hook of UPDATE_HOOKS) {
    // Post hook: an upserted document only exists after the write, so this is
    // where the filter reliably resolves to an id.
    schema.post(hook, function (this: QueryLike) {
      void queueQueryUpsert(this).catch(() => undefined);
    });
  }

  for (const hook of DELETE_HOOKS) {
    schema.pre(hook, async function (this: QueryLike) {
      await queueQueryDelete(this).catch(() => undefined);
    });
  }
}
