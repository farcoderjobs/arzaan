"use client";

/**
 * Sync engine — drains the IndexedDB queue into POST /api/sync/sale.
 *
 * Triggers:
 *  - app start (if anything is queued and the network is up)
 *  - browser `online` event (after a successful health probe)
 *  - tab becomes visible again
 *  - periodic sweep (only does work when entries are due)
 *  - manual "Sync now" from the Sync Center
 *
 * Rules:
 *  - one run at a time (module-level guard)
 *  - entries are processed strictly oldest-first (invoice order preserved)
 *  - transient errors (network, 5xx) → attempts++ and the 30s/60s/2m/5m backoff
 *  - session expiry (401) → rotate the session via the refresh cookie and
 *    retry once; if still unauthorized, back off as PENDING (never FAILED —
 *    the sale becomes syncable again the moment the cashier logs back in)
 *  - permanent errors (4xx validation / stock conflict) → FAILED with the
 *    server message; they wait for a manual retry and record a conflict
 *  - status indicator: SYNCING while a run is active, SYNC COMPLETE when a
 *    run finished with at least one synced sale
 */

import {
  getConnectivitySnapshot,
  probeHealth,
  setConnectionStatus,
  setPendingCount,
  subscribeConnectivity,
} from "./connectivity";
import { backoffDelayMs, isDue, type QueueStatus } from "./backoff";
import {
  addConflict,
  countUnsynced,
  listPendingQueue,
  markSynced,
  updateQueuedSale,
  type QueuedSale,
} from "./db";

const PERIODIC_SWEEP_MS = 60_000;

export interface SyncRunResult {
  synced: number;
  failed: number;
  /** Entries still waiting (pending + failed + syncing). */
  remaining: number;
}

let running = false;
let started = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** True while a sync run is in progress. */
export function isSyncRunning(): boolean {
  return running;
}

/**
 * Drains every due queue entry. `force` (manual Sync now) ignores backoff
 * windows but still respects one-run-at-a-time.
 */
export async function syncNow(options: { force?: boolean } = {}): Promise<SyncRunResult> {
  const result: SyncRunResult = { synced: 0, failed: 0, remaining: 0 };
  if (running) {
    result.remaining = await countUnsynced();
    return result;
  }
  running = true;
  try {
    const online = getConnectivitySnapshot().status !== "OFFLINE";
    if (!online) {
      result.remaining = await countUnsynced();
      return result;
    }

    const queue = await listPendingQueue();
    if (queue.length === 0) {
      result.remaining = 0;
      return result;
    }

    const now = Date.now();
    const due = queue.filter((e) => options.force || isDue(e, now));
    if (due.length === 0) {
      result.remaining = await countUnsynced();
      return result;
    }

    setConnectionStatus("SYNCING");

    for (const entry of due) {
      const outcome = await syncEntry(entry);
      if (outcome === "synced") result.synced += 1;
      else if (outcome === "failed") result.failed += 1;
      // "retry" entries keep PENDING status with a scheduled next attempt
    }

    result.remaining = await countUnsynced();
    setPendingCount(result.remaining);

    if (result.synced > 0 && result.failed === 0 && result.remaining === 0) {
      setConnectionStatus("SYNC_COMPLETE");
    } else {
      // Anything left keeps the indicator honest (ONLINE with a pending badge).
      setConnectionStatus("ONLINE");
    }
    return result;
  } catch (err) {
    console.error("[sync] run failed:", err);
    setConnectionStatus("ONLINE");
    result.remaining = await countUnsynced();
    return result;
  } finally {
    running = false;
    setPendingCount(await countUnsynced());
  }
}

type EntryOutcome = "synced" | "failed" | "retry" | "skipped";

async function postQueuedSale(entry: QueuedSale): Promise<Response> {
  return fetch("/api/sync/sale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientTransactionId: entry.clientTransactionId,
      ...entry.payload,
    }),
  });
}

/**
 * Rotates the session through the refresh cookie (the response's Set-Cookie
 * updates the jar for all subsequent requests). True when a fresh access
 * token is now available.
 */
async function refreshSession(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/[...nextauth]", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "refresh" }),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function syncEntry(entry: QueuedSale): Promise<EntryOutcome> {
  // Claim the entry so a second tab doesn't double-send it.
  await updateQueuedSale({ ...entry, status: "SYNCING" });

  try {
    let res = await postQueuedSale(entry);

    if (res.status === 401) {
      // The access token expired while the device was offline (long-running
      // POS terminals stay signed in for weeks). The sale itself is fine —
      // only the session needs renewing, so rotate it and retry once.
      if (await refreshSession()) {
        res = await postQueuedSale(entry);
      }
      if (res.status === 401) {
        // Refresh token dead too. Keep the entry PENDING with backoff so it
        // drains automatically once the cashier logs back in — auth problems
        // must NEVER become a permanent FAILED (the sale would be stranded).
        return scheduleRetry(entry, "Session expired — log in to resume syncing");
      }
    }

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const invoiceNumber =
        typeof data?.data?.invoiceNumber === "string" ? data.data.invoiceNumber : null;
      await markSynced(entry.clientTransactionId, invoiceNumber);
      return "synced";
    }

    const body = await res.json().catch(() => ({}));
    const code = body?.error?.code ?? `HTTP_${res.status}`;
    const message: string = body?.error?.message ?? `Server rejected the sale (${res.status})`;

    if (res.status >= 500) {
      // Transient server problem — back off and retry later.
      return scheduleRetry(entry, message);
    }

    // Permanent rejection (validation, insufficient stock, permissions).
    await recordFailure(entry, code, message);
    return "failed";
  } catch {
    // Network dropped mid-request (or backend unreachable) — back off.
    return scheduleRetry(entry, "Network error");
  }
}

async function scheduleRetry(entry: QueuedSale, message: string): Promise<EntryOutcome> {
  const attempts = entry.attempts + 1;
  const failedAt = Date.now();
  await updateQueuedSale({
    ...entry,
    status: "PENDING",
    attempts,
    lastError: message,
    nextAttemptAt: failedAt + backoffDelayMs(attempts),
  });
  return "retry";
}

async function recordFailure(entry: QueuedSale, code: string, message: string): Promise<EntryOutcome> {
  await updateQueuedSale({
    ...entry,
    status: "FAILED",
    attempts: entry.attempts + 1,
    lastError: `${code}: ${message}`,
    // Manual retry required — no automatic backoff scheduling.
    nextAttemptAt: Number.MAX_SAFE_INTEGER,
  });
  await addConflict({
    id: `${entry.clientTransactionId}-${Date.now()}`,
    clientTransactionId: entry.clientTransactionId,
    kind: code === "INSUFFICIENT_STOCK" ? "STOCK_CONFLICT" : "REJECTED",
    productId: entry.payload.items[0]?.productId ?? null,
    message: `${code}: ${message}`,
    createdAt: Date.now(),
    resolved: false,
  });
  return "failed";
}

/** Requeues a FAILED entry for an immediate manual retry. */
export async function retryEntry(clientTransactionId: string, entry: QueuedSale): Promise<void> {
  await updateQueuedSale({
    ...entry,
    status: "PENDING" as QueueStatus,
    nextAttemptAt: Date.now(),
    lastError: entry.lastError,
  });
}

/** Requeues every FAILED entry, then runs a forced sync. */
export async function retryAll(): Promise<SyncRunResult> {
  const queue = await listPendingQueue();
  for (const entry of queue) {
    if (entry.status === "FAILED") {
      await updateQueuedSale({
        ...entry,
        status: "PENDING",
        nextAttemptAt: Date.now(),
      });
    }
  }
  return syncNow({ force: true });
}

async function maybeSync(options: { force?: boolean } = {}): Promise<void> {
  if (running) return;
  if (getConnectivitySnapshot().status === "OFFLINE") return;
  const pending = await countUnsynced();
  setPendingCount(pending);
  if (pending === 0) return;
  await syncNow(options);
}

/**
 * Starts the engine: sweep timer + reconnect/visibility triggers.
 * Idempotent — safe to call from multiple React roots.
 */
export function startSyncEngine(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  // App start: push anything that was queued last session.
  void maybeSync();

  window.addEventListener("online", () => {
    // Give the connectivity probe a moment; syncNow re-checks status anyway.
    void probeHealth().then(() => maybeSync({ force: true }));
  });

  // Reconnect detection via the connectivity service: the browser `online`
  // event is unreliable (navigator.onLine can be stale behind a service
  // worker / emulator), so we also watch the health-probe-driven status. A
  // genuine OFFLINE → ONLINE transition means the network is really back —
  // attempt an immediate (forced) drain; backoff only paces retries while
  // the server keeps failing.
  let lastStatus = getConnectivitySnapshot().status;
  subscribeConnectivity(() => {
    const status = getConnectivitySnapshot().status;
    const prev = lastStatus;
    lastStatus = status;
    if (status === "ONLINE" && prev === "OFFLINE") {
      void maybeSync({ force: true });
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void maybeSync();
  });

  sweepTimer = setInterval(() => void maybeSync(), PERIODIC_SWEEP_MS);
}

export function stopSyncEngine(): void {
  if (!started) return;
  started = false;
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
