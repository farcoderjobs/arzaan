"use client";

import { useSyncStatus } from "@/lib/sync/use-sync-status";
import { describeSyncState } from "@/lib/sync/status-types";
import { useT } from "@/i18n/client";
import { cn } from "@/utils/classname";

/**
 * Connectivity / sync indicator for the header.
 *
 * It reflects the SHOP NODE's link to the online center, not the browser's own
 * connectivity: the browser always talks to the local server, and everything it
 * saves is already durable locally. "Offline" therefore means "the center has
 * not received the latest changes yet", which is a state the shop works in
 * normally.
 */
export function ConnectionIndicator() {
  const { status, error } = useSyncStatus();
  const t = useT();

  const state = describeSyncState(status);
  const pending = status
    ? status.counts.pending + status.counts.sending + status.counts.failed
    : 0;

  const label = error
    ? t.offline.offline
    : state === "ONLINE"
      ? t.offline.online
      : state === "OFFLINE"
        ? t.offline.offline
        : state === "SYNCING"
          ? t.offline.syncing
          : state === "SYNC_COMPLETE"
            ? t.offline.syncComplete
            : t.offline.notConfigured;

  const title = error
    ? t.offline.localServerError
    : pending > 0
      ? t.offline.pendingCount.replace("{count}", String(pending))
      : label;

  return (
    <div
      role="status"
      aria-live="polite"
      data-status={state.toLowerCase()}
      data-sync-indicator
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium",
        state === "ONLINE" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        state === "OFFLINE" && "border-amber-200 bg-amber-50 text-amber-700",
        state === "SYNCING" && "border-blue-200 bg-blue-50 text-blue-700",
        state === "SYNC_COMPLETE" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        state === "UNCONFIGURED" && "border-slate-200 bg-slate-50 text-slate-600"
      )}
      title={title}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          state === "ONLINE" && "bg-emerald-500",
          state === "OFFLINE" && "bg-amber-500",
          state === "SYNCING" && "animate-pulse bg-blue-500",
          state === "SYNC_COMPLETE" && "bg-emerald-500",
          state === "UNCONFIGURED" && "bg-slate-400"
        )}
      />
      <span className="hidden sm:inline">{label}</span>
      {pending > 0 && (
        <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">
          {pending}
        </span>
      )}
    </div>
  );
}
