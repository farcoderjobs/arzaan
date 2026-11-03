"use client";

import { useCallback, useEffect, useState } from "react";
import type { SyncStatus } from "./status-types";

/**
 * Reads the node's sync status from the LOCAL server.
 *
 * The browser holds no queue any more: every change and every pending
 * operation lives in the shop's local MongoDB (see docs/OFFLINE.md), so the UI
 * only needs to poll this one endpoint. That is also why a page refresh, a
 * browser restart or a crash can never lose a sale — there is nothing on the
 * client to lose.
 */

const DEFAULT_POLL_MS = 20_000;

export type UseSyncStatusResult = {
  status: SyncStatus | null;
  loading: boolean;
  /** Set when the local server itself could not be reached. */
  error: string | null;
  refresh: () => Promise<void>;
};

export function useSyncStatus(options: { pollMs?: number; enabled?: boolean } = {}): UseSyncStatusResult {
  const { pollMs = DEFAULT_POLL_MS, enabled = true } = options;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SyncStatus;
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unreachable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // The first load is deferred out of the effect body: a state update must
    // not run synchronously while the effect is flushing (cascading renders).
    const first = setTimeout(() => void refresh(), 0);

    const timer = setInterval(() => void refresh(), pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, pollMs, refresh]);

  return { status, loading, error, refresh };
}
