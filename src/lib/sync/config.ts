/**
 * Offline-first node configuration.
 *
 * Every process is one of two roles:
 *
 *  - `shop`   (default) — runs the POS against its LOCAL MongoDB
 *                          (`MONGODB_URI`, e.g. mongodb://127.0.0.1:27017/pos)
 *                          and pushes every change to the center.
 *  - `center`           — hosts the online MongoDB and accepts pushes/pulls.
 *
 * Values are read from `process.env` directly (never through the strict env
 * schema) so that a half-configured node still boots: the Sync Center UI then
 * explains exactly which variables are missing instead of the app refusing to
 * start.
 */

import { isUsingFallbackDatabase } from "@/lib/db-mode";

export type SyncRole = "shop" | "center";

export type SyncConfig = {
  role: SyncRole;
  /** Node identity sent with every push/pull. */
  nodeId: string;
  nodeName: string;
  /** Shared secret issued by the center (`POST /api/sync/nodes`). */
  nodeKey: string | null;
  /** Base URL of the center app, e.g. https://pos.example.com */
  onlineUrl: string | null;
  /** How changes reach the online database. */
  transport: "http" | "direct";
  /** The BACKGROUND loop should run (false on `center`, or when disabled). */
  enabled: boolean;
  /**
   * Push is possible at all: role, URL, node id and key are configured.
   * Independent of `enabled` so an installation can drive sync on demand
   * (`POST /api/sync/run`) with the background loop switched off.
   */
  pushEnabled: boolean;
  pullEnabled: boolean;
  intervalMs: number;
  batchSize: number;
  /** Human-readable list of the missing pieces, shown in the Sync Center. */
  missing: string[];
};

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 200;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function truthy(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw === "true" || raw === "1";
}

export function getSyncRole(): SyncRole {
  return process.env.NODE_ROLE === "center" ? "center" : "shop";
}

export function getSyncConfig(): SyncConfig {
  const role = getSyncRole();
  const onlineUrl = (process.env.SYNC_ONLINE_URL ?? "").trim().replace(/\/+$/, "") || null;
  const localUri = (process.env.MONGODB_LOCAL_URI ?? "").trim();
  const onlineUri = (process.env.MONGODB_URI ?? "").trim();

  /**
   * No center app deployed, but the process already owns a local database and
   * knows the online one: replicate straight into it. Using MONGODB_URI as the
   * target is what makes "Sync now" work on a single-PC install with only
   * MongoDB Compass and an Atlas cluster.
   */
  const direct =
    role === "shop" &&
    !onlineUrl &&
    Boolean(localUri) &&
    Boolean(onlineUri) &&
    localUri !== onlineUri;

  const nodeId = (process.env.SYNC_NODE_ID ?? "").trim() || (direct ? "shop-local" : "");
  const nodeKey = (process.env.SYNC_NODE_KEY ?? "").trim() || null;
  const enabled = truthy(process.env.SYNC_ENABLED, true) && role === "shop";

  const missing: string[] = [];
  if (role === "shop" && !direct) {
    if (!onlineUrl) missing.push("SYNC_ONLINE_URL");
    if (!nodeId) missing.push("SYNC_NODE_ID");
    if (!nodeKey) missing.push("SYNC_NODE_KEY");
  }

  const pushEnabled = role === "shop" && (direct || Boolean(onlineUrl && nodeId && nodeKey));

  return {
    role,
    transport: direct ? "direct" : "http",
    nodeId,
    nodeName: (process.env.SYNC_NODE_NAME ?? "").trim() || nodeId || "shop",
    nodeKey,
    onlineUrl,
    enabled,
    pushEnabled,
    pullEnabled: pushEnabled && truthy(process.env.SYNC_PULL_ENABLED, true),
    intervalMs: positiveInt(process.env.SYNC_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    batchSize: positiveInt(process.env.SYNC_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    missing,
  };
}

/**
 * Dirty-document tracking only runs where the process owns the shop database.
 * The center never tracks its own writes, so HQ edits cannot echo back to the
 * shops through the pull channel.
 *
 * Deliberately independent of `SYNC_ENABLED`: tracking is what makes the local
 * database the source of truth, so a node that is not pushing yet still records
 * everything it must send later.
 */
export function isTrackingEnabled(): boolean {
  if (getSyncRole() !== "shop") return false;
  // Running on the fallback (online) database means this process's writes are
  // NOT landing in the shop's local database. Queuing them for replication
  // would push cloud rows back to the center and duplicate them, so tracking
  // stays off until the local MongoDB is running again.
  return !isUsingFallbackDatabase();
}
