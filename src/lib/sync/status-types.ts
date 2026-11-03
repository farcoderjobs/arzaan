/**
 * Shapes shared by the server's sync status endpoint and the browser that
 * consumes it. Contains NO imports on purpose: client components may import
 * these types (erased at build time) without pulling mongoose into the bundle.
 */

export type LocalDatabaseInfo = {
  dbName: string | null;
  topology: string | null;
  /** null when it could not be determined (not connected yet). */
  transactionsSupported: boolean | null;
  standalone: boolean;
  checkedAt: string | null;
};

export type SyncRunView = {
  _id: string;
  kind: string;
  status: string;
  pushed: number;
  failed: number;
  conflicted: number;
  remaining: number;
  pulled: number;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type SyncStatus = {
  role: string;
  /** "direct" = this server writes to the online database itself (no center app). */
  transport: "http" | "direct";
  enabled: boolean;
  configured: boolean;
  missing: string[];
  nodeId: string;
  nodeName: string;
  onlineUrl: string | null;
  pushEnabled: boolean;
  pullEnabled: boolean;
  workerRunning: boolean;
  /** Database this process is actually using (see `src/lib/mongodb.ts`). */
  databaseMode: "local" | "primary" | "fallback" | null;
  /** True when MONGODB_LOCAL_URI is configured on this server. */
  localDatabaseConfigured: boolean;
  localDb: LocalDatabaseInfo;
  schemaVersion: number;
  schemaTargetVersion: number;
  counts: { pending: number; sending: number; failed: number; synced: number; conflicts: number };
  connectivity: {
    reachable: boolean | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastError: { at: string; message: string; needsIntervention?: boolean } | null;
    pullLastError: { at: string; message: string } | null;
  };
  trackingError: { at: string; message: string } | null;
  migrationError: unknown;
  runs: SyncRunView[];
};

export type SyncRunSummary = {
  runId: string;
  kind: string;
  pushed: number;
  conflicted: number;
  failed: number;
  pulled: number;
  remaining: number;
  reachable: boolean;
  message: string;
  startedAt: string;
  finishedAt: string;
};

export type SyncOutboxRowView = {
  rowKey: string;
  collection: string;
  docId: string;
  entityType: string;
  operation: "upsert" | "delete";
  status: "PENDING" | "SENDING" | "SYNCED" | "FAILED";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
};

export type SyncConflictView = {
  conflictKey: string;
  rowKey: string;
  collection: string;
  docId: string;
  entityType: string;
  kind: string;
  message: string;
  retryable: boolean;
  resolved: boolean;
  resolution: string;
  payload: unknown;
  createdAt: string;
  resolvedAt: string | null;
};

/** How the connection indicator should present the node. */
export type SyncVisualState = "ONLINE" | "OFFLINE" | "SYNCING" | "SYNC_COMPLETE" | "UNCONFIGURED";

/**
 * Maps a status snapshot onto the indicator's states.
 *
 * "Offline" here means the CENTER is unreachable — the shop keeps working: the
 * browser talks to the local server, which owns the data.
 */
export function describeSyncState(status: SyncStatus | null): SyncVisualState {
  if (!status) return "UNCONFIGURED";
  if (!status.pushEnabled && !status.pullEnabled) return "UNCONFIGURED";
  // Local database missing: the shop is not recording into its own database,
  // so it must not look "online" even if the center happens to be reachable.
  if (status.databaseMode === "fallback") return "OFFLINE";
  if (status.workerRunning) return "SYNCING";
  if (status.connectivity.reachable === false) return "OFFLINE";
  const pending = status.counts.pending + status.counts.sending + status.counts.failed;
  if (pending === 0 && status.counts.synced > 0) return "SYNC_COMPLETE";
  return "ONLINE";
}
