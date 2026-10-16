"use client";

/**
 * Connectivity service for the offline-first POS.
 *
 * Statuses:
 *  - ONLINE:        backend reachable (health probe OK)
 *  - OFFLINE:       backend unreachable (navigator.onLine false or probe failed)
 *  - SYNCING:       sync engine is pushing queued offline sales
 *  - SYNC_COMPLETE: a sync run just finished successfully (transient, falls
 *                   back to ONLINE after a short delay)
 *
 * navigator.onLine alone is unreliable (captive portals, server down), so we
 * periodically probe GET /api/health with a timeout and also react to the
 * browser online/offline events for instant transitions.
 */

export type ConnectionStatus = "ONLINE" | "OFFLINE" | "SYNCING" | "SYNC_COMPLETE";

export interface ConnectivitySnapshot {
  status: ConnectionStatus;
  /** Last time a health probe succeeded (epoch ms), null if never. */
  lastOnlineAt: number | null;
  /** Last time we detected offline (epoch ms), null if never. */
  lastOfflineAt: number | null;
  /** Number of queued offline sales awaiting sync (fed by the sync engine). */
  pendingCount: number;
}

const HEALTH_URL = "/api/health";
const PROBE_INTERVAL_MS = 20_000;
const PROBE_TIMEOUT_MS = 4_000;
const SYNC_COMPLETE_DISPLAY_MS = 4_000;

let snapshot: ConnectivitySnapshot = {
  status: typeof navigator !== "undefined" && navigator.onLine === false ? "OFFLINE" : "ONLINE",
  lastOnlineAt: null,
  lastOfflineAt: null,
  pendingCount: 0,
};

const listeners = new Set<() => void>();
let probeTimer: ReturnType<typeof setInterval> | null = null;
let syncCompleteTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function emit(next: Partial<ConnectivitySnapshot>): void {
  const merged = { ...snapshot, ...next };
  if (
    merged.status === snapshot.status &&
    merged.lastOnlineAt === snapshot.lastOnlineAt &&
    merged.lastOfflineAt === snapshot.lastOfflineAt &&
    merged.pendingCount === snapshot.pendingCount
  ) {
    return;
  }
  snapshot = merged;
  for (const listener of listeners) listener();
}

/** Sets status directly (used by the sync engine while it drains the queue). */
export function setConnectionStatus(status: ConnectionStatus): void {
  if (status === "SYNC_COMPLETE") {
    if (syncCompleteTimer) clearTimeout(syncCompleteTimer);
    syncCompleteTimer = setTimeout(() => {
      syncCompleteTimer = null;
      // Only clear the transient badge — never clobber OFFLINE/SYNCING.
      if (snapshot.status === "SYNC_COMPLETE") emit({ status: "ONLINE" });
    }, SYNC_COMPLETE_DISPLAY_MS);
  }
  emit({ status });
}

/** Updates the queued-sales counter shown by the indicator. */
export function setPendingCount(count: number): void {
  emit({ pendingCount: Math.max(0, count) });
}

export function getConnectivitySnapshot(): ConnectivitySnapshot {
  return snapshot;
}

export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Probes the backend once; returns true when reachable. */
export async function probeHealth(): Promise<boolean> {
  if (typeof fetch === "undefined") return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(HEALTH_URL, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    const ok = res.ok;
    recordProbeResult(ok);
    return ok;
  } catch {
    recordProbeResult(false);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function recordProbeResult(ok: boolean): void {
  if (ok) {
    // A successful probe must not clobber an in-progress sync display.
    if (snapshot.status === "SYNCING" || snapshot.status === "SYNC_COMPLETE") {
      emit({ lastOnlineAt: Date.now() });
    } else {
      emit({ status: "ONLINE", lastOnlineAt: Date.now() });
    }
  } else {
    emit({ status: "OFFLINE", lastOfflineAt: Date.now() });
  }
}

function handleBrowserOnline(): void {
  // Browser says the network is back — verify the backend really is before
  // flipping to ONLINE (avoids false positives from captive portals).
  void probeHealth();
}

function handleBrowserOffline(): void {
  emit({ status: "OFFLINE", lastOfflineAt: Date.now() });
}

/**
 * Starts the connectivity watcher. Safe to call multiple times (idempotent),
 * and safe to call from multiple React roots.
 */
export function startConnectivity(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  window.addEventListener("online", handleBrowserOnline);
  window.addEventListener("offline", handleBrowserOffline);

  void probeHealth();
  probeTimer = setInterval(() => {
    // Skip probing while offline-flagged by the browser — the online event
    // will re-trigger a probe the moment connectivity returns.
    if (navigator.onLine !== false) void probeHealth();
  }, PROBE_INTERVAL_MS);
}

/** Stops the watcher (used by tests). */
export function stopConnectivity(): void {
  if (!started) return;
  started = false;
  window.removeEventListener("online", handleBrowserOnline);
  window.removeEventListener("offline", handleBrowserOffline);
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
  if (syncCompleteTimer) {
    clearTimeout(syncCompleteTimer);
    syncCompleteTimer = null;
  }
}
