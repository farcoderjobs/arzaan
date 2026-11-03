import { apiErrorMessage } from "@/lib/api";
import { SyncOutbox } from "@/models";
import { getSyncConfig, type SyncConfig } from "./config";
import { PULL_COLLECTIONS, isPullableCollection } from "./deltas";
import { getState, setState } from "./outbox";
import { withoutSyncTracking } from "./tracking";
import { getModelForCollection } from "./registry";
import { policyFor } from "./policy";

/**
 * Pulls reference-data deltas from the center.
 *
 * Rules:
 *  - a document with a pending (or failed) local edit is SKIPPED: the shop's
 *    unsent change wins until it has been pushed — the center must never be
 *    able to overwrite work that has not been synced yet;
 *  - writes are applied with tracking suppressed, otherwise every pulled
 *    document would immediately be queued back to the center;
 *  - per-collection cursors are stored in `SyncState`, so an interrupted pull
 *    resumes exactly where it stopped.
 *
 * Known limitation (documented in docs/OFFLINE.md): deletions made at the
 * center do not propagate. The app deactivates records instead of deleting
 * them, and an inactive record is replicated like any other field.
 */

const PULL_TIMEOUT_MS = 30_000;

export type PullSummary = {
  configured: boolean;
  reachable: boolean;
  applied: number;
  message: string;
};

export async function pullCursors(): Promise<Record<string, string>> {
  const cursors: Record<string, string> = {};
  for (const collection of PULL_COLLECTIONS) {
    const value = await getState<string | null>(`pull.cursor.${collection}`, null);
    if (value) cursors[collection] = value;
  }
  return cursors;
}

async function requestDeltas(
  config: SyncConfig,
  cursors: Record<string, string>
): Promise<{ ok: true; body: PullBatchBody } | { ok: false; reachable: boolean; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.onlineUrl}/api/sync/pull`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sync-node-id": config.nodeId,
        "x-sync-node-key": config.nodeKey ?? "",
      },
      body: JSON.stringify({ cursors, limit: 500, nodeName: config.nodeName }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return {
        ok: false,
        reachable: true,
        message: apiErrorMessage(body, `The center refused the pull (HTTP ${res.status})`),
      };
    }

    const body = (await res.json().catch(() => null)) as { data?: PullBatchBody } | null;
    if (!body?.data) {
      return { ok: false, reachable: true, message: "The center returned an empty pull response" };
    }
    return { ok: true, body: body.data };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      message: err instanceof Error ? err.message : "Network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

type PullBatchBody = {
  docs?: Record<string, Array<Record<string, unknown>>>;
  cursors?: Record<string, string>;
  hasMore?: boolean;
};

export async function pullFromCenter(): Promise<PullSummary> {
  const config = getSyncConfig();
  if (!config.pullEnabled) {
    return {
      configured: false,
      reachable: false,
      applied: 0,
      message: config.missing.length > 0 ? "Sync is not configured" : "Pull is disabled",
    };
  }

  const cursors = await pullCursors();
  let applied = 0;
  let hasMore = true;
  let rounds = 0;

  // Bounded rounds: a first bootstrap can be large, but the worker must never
  // monopolise the process.
  while (hasMore && rounds < 10) {
    rounds += 1;
    const result = await requestDeltas(config, cursors);
    if (!result.ok) {
      await setState("pull.lastError", { at: new Date().toISOString(), message: result.message });
      return {
        configured: true,
        reachable: result.reachable,
        applied,
        message: result.message,
      };
    }

    applied += await applyDeltas(result.body);
    for (const [collection, cursor] of Object.entries(result.body.cursors ?? {})) {
      if (cursor) cursors[collection] = cursor;
    }
    hasMore = Boolean(result.body.hasMore);
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

/** Applies one batch of center documents locally. */
export async function applyDeltas(body: PullBatchBody): Promise<number> {
  let applied = 0;

  for (const [collection, docs] of Object.entries(body.docs ?? {})) {
    if (!isPullableCollection(collection) || !policyFor(collection)) continue;
    const model = getModelForCollection(collection);
    if (!model) continue;

    for (const doc of docs) {
      const docId = String(doc._id ?? "");
      if (!docId) continue;

      // A local, unsent edit always wins over the center's copy.
      const locallyPending = await SyncOutbox.exists({
        collectionName: collection,
        docId,
        status: { $in: ["PENDING", "SENDING", "FAILED"] },
      });
      if (locallyPending) continue;

      const incoming = { ...doc };
      delete incoming._id;

      try {
        await withoutSyncTracking(async () => {
          await model.updateOne({ _id: docId }, { $set: incoming }, { timestamps: false, strict: false });
        });
        applied += 1;
      } catch (err) {
        console.error(`[sync] applying pulled ${collection}:${docId} failed`, err);
      }
    }
  }

  return applied;
}
