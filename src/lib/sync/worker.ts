import { getSyncConfig, getSyncRole } from "./config";
import { pushOutbox } from "./push";
import { pullFromCenter } from "./pull";
import { pullDirect } from "./direct";
import {
  countOpenConflicts,
  finishRun,
  getState,
  listRuns,
  outboxCounts,
  pruneSyncedRows,
  resetStuckRows,
  setState,
  startRun,
} from "./outbox";
import { LOCAL_SCHEMA_VERSION, assertLocalSchemaSupported, localSchemaVersion, runLocalMigrations } from "./local-migrations";
import { probeLocalDatabase } from "./local-db";
import { getDatabaseMode } from "@/lib/db-mode";
import { hasLocalDatabase } from "@/lib/mongodb";
import type { SyncRunSummary, SyncStatus } from "./status-types";

/**
 * The node's sync worker.
 *
 * It owns one loop: push everything that is due, then pull reference-data
 * deltas. Combined with the connectivity-independent design (the POS always
 * talks to the local server) that means a shop keeps selling while the center
 * is unreachable, and catches up on its own once it is not.
 *
 * Triggers: server start, every `SYNC_INTERVAL_MS`, and the manual "Sync now"
 * action in the Sync Center. Only one run happens at a time — both the in-process
 * guard and the outbox row states prevent double pushes.
 */

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type { SyncRunSummary, SyncStatus };

type WorkerGlobal = {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  started: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __posSyncWorker: WorkerGlobal | undefined;
}

function workerState(): WorkerGlobal {
  if (!globalThis.__posSyncWorker) {
    globalThis.__posSyncWorker = { timer: null, running: false, started: false };
  }
  return globalThis.__posSyncWorker;
}

export function isSyncRunning(): boolean {
  return workerState().running;
}

export function isSyncWorkerStarted(): boolean {
  return workerState().started;
}

/**
 * One full sync pass. Safe to call concurrently: a second caller returns the
 * outcome of "nothing to do" instead of pushing the same rows twice.
 */
export async function syncNow(options: { force?: boolean; kind?: string } = {}): Promise<SyncRunSummary> {
  const state = workerState();
  const config = getSyncConfig();
  const kind = options.kind ?? (options.force ? "manual" : "auto");
  const startedAt = new Date();

  if (state.running) {
    const counts = await outboxCounts();
    return {
      runId: "",
      kind,
      pushed: 0,
      conflicted: 0,
      failed: 0,
      pulled: 0,
      remaining: counts.pending + counts.sending + counts.failed,
      reachable: true,
      message: "A sync run is already in progress",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  state.running = true;
  let runId = "";
  try {
    if (!(await assertLocalSchemaSupported())) {
      const counts = await outboxCounts();
      return {
        runId: "",
        kind,
        pushed: 0,
        conflicted: 0,
        failed: 0,
        pulled: 0,
        remaining: counts.pending + counts.sending + counts.failed,
        reachable: false,
        message: "This application is older than the local database schema — update it before syncing",
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
      };
    }

    // Rows left SENDING by a crash go back into the queue.
    await resetStuckRows();
    runId = await startRun(kind, config.nodeId);

    const push = config.pushEnabled
      ? await pushOutbox({ force: options.force })
      : {
          configured: false,
          reachable: false,
          attempted: 0,
          pushed: 0,
          conflicted: 0,
          failed: 0,
          message: config.missing.length > 0 ? `Not configured: ${config.missing.join(", ")}` : "Sync disabled",
        };

    // Only worth pulling when the center actually answered.
    const pull = config.pullEnabled && push.reachable
      ? config.transport === "direct"
        ? await pullDirect()
        : await pullFromCenter()
      : { configured: config.pullEnabled, reachable: false, applied: 0, message: "" };

    const counts = await outboxCounts();
    const remaining = counts.pending + counts.sending + counts.failed;
    const message = [push.message, pull.message].filter(Boolean).join(" · ");

    const summary = {
      status: (push.failed > 0 && push.pushed === 0 ? "failed" : "completed") as "failed" | "completed",
      pushed: push.pushed,
      failed: push.failed,
      conflicted: push.conflicted,
      remaining,
      pulled: pull.applied,
      message,
    };
    await finishRun(runId, summary);
    await setState("run.last", { ...summary, kind, at: new Date().toISOString() });
    await maybePrune();

    return {
      runId,
      kind,
      ...summary,
      reachable: push.reachable,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    if (runId) {
      const counts = await outboxCounts().catch(() => ({ pending: 0, sending: 0, failed: 0, synced: 0 }));
      await finishRun(runId, {
        status: "failed",
        pushed: 0,
        failed: 0,
        conflicted: 0,
        remaining: counts.pending + counts.sending + counts.failed,
        pulled: 0,
        message,
      }).catch(() => undefined);
    }
    console.error("[sync] run failed", err);
    return {
      runId,
      kind,
      pushed: 0,
      conflicted: 0,
      failed: 0,
      pulled: 0,
      remaining: 0,
      reachable: false,
      message,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  } finally {
    state.running = false;
  }
}

async function maybePrune(): Promise<void> {
  try {
    const last = await getState<string | null>("prune.lastAt", null);
    if (last && Date.now() - new Date(last).getTime() < PRUNE_INTERVAL_MS) return;
    await pruneSyncedRows(7);
    await setState("prune.lastAt", new Date().toISOString());
  } catch (err) {
    console.error("[sync] pruning synced rows failed", err);
  }
}

/**
 * Starts the background loop. Idempotent and HMR-safe: the timer lives on
 * globalThis so a dev-server reload cannot leave two loops running.
 */
export function startSyncWorker(): void {
  const state = workerState();
  const config = getSyncConfig();

  if (state.started) {
    // A process that booted before the online database was configured left the
    // loop unarmed. Arm it now instead of requiring a restart.
    if (!state.timer && (config.pushEnabled || config.pullEnabled)) {
      state.timer = setInterval(() => void syncNow(), config.intervalMs);
    }
    return;
  }

  if (getSyncRole() !== "shop") return; // the center never pushes to itself
  if (!config.enabled) return;

  state.started = true;

  void runLocalMigrations().catch((err) => console.error("[sync] local migration failed", err));
  void probeLocalDatabase(true).catch(() => undefined);

  if (config.pushEnabled || config.pullEnabled) {
    // First pass shortly after boot, then on every interval.
    setTimeout(() => void syncNow({ kind: "startup" }), 5_000);
    state.timer = setInterval(() => void syncNow(), config.intervalMs);
  } else {
    console.warn(
      `[sync] push/pull disabled — missing ${config.missing.join(", ") || "configuration"}. ` +
        "Sales are still saved locally and stay queued in the outbox."
    );
  }
}

export function stopSyncWorker(): void {
  const state = workerState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.started = false;
}

/* ------------------------------- status -------------------------------- */



export async function getSyncStatus(): Promise<SyncStatus> {
  const config = getSyncConfig();
  const [counts, conflicts, localDb, schemaVersion, runs, pushAttempt, pushSuccess, pushError, pullError, trackingError, migrationError] =
    await Promise.all([
      outboxCounts(),
      countOpenConflicts(),
      probeLocalDatabase(),
      localSchemaVersion(),
      listRuns(10),
      getState<string | null>("push.lastAttemptAt", null),
      getState<string | null>("push.lastSuccessAt", null),
      getState<{ at: string; message: string; needsIntervention?: boolean } | null>("push.lastError", null),
      getState<{ at: string; message: string } | null>("pull.lastError", null),
      getState<{ at: string; message: string } | null>("tracking.lastError", null),
      getState<unknown>("local.migrationError", null),
    ]);

  // "Reachable" is the last real outcome: a failed attempt after the last
  // success means the center is currently unreachable (or refusing us).
  let reachable: boolean | null = null;
  if (pushError) {
    reachable = Boolean(pushSuccess && new Date(pushSuccess).getTime() > new Date(pushError.at).getTime());
  } else if (pushSuccess) {
    reachable = true;
  }

  return {
    role: config.role,
    transport: config.transport,
    enabled: config.enabled,
    configured: config.pushEnabled,
    missing: config.missing,
    nodeId: config.nodeId,
    nodeName: config.nodeName,
    onlineUrl: config.onlineUrl,
    pushEnabled: config.pushEnabled,
    pullEnabled: config.pullEnabled,
    workerRunning: isSyncRunning(),
    databaseMode: getDatabaseMode(),
    localDatabaseConfigured: hasLocalDatabase(),
    localDb,
    schemaVersion,
    schemaTargetVersion: LOCAL_SCHEMA_VERSION,
    counts: { ...counts, conflicts },
    connectivity: {
      reachable,
      lastAttemptAt: pushAttempt,
      lastSuccessAt: pushSuccess,
      lastError: pushError,
      pullLastError: pullError,
    },
    trackingError,
    migrationError,
    runs: runs.map((run) => ({
      _id: String(run._id),
      kind: run.kind,
      status: run.status,
      pushed: run.pushed,
      failed: run.failed,
      conflicted: run.conflicted,
      remaining: run.remaining,
      pulled: run.pulled,
      message: run.message,
      startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
      finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    })),
  };
}
