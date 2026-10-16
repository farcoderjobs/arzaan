"use client";

import { useConnectivity } from "@/lib/offline/use-connectivity";
import { useT } from "@/i18n/client";
import { cn } from "@/utils/classname";

/**
 * Persistent connectivity / sync indicator shown in the app header.
 *
 * Shows ONLINE (green), OFFLINE (red), SYNCING (amber, animated) or
 * SYNC COMPLETE (blue) plus the number of sales waiting to sync.
 */
export function ConnectionIndicator() {
  const { status, pendingCount } = useConnectivity();
  const t = useT();

  const label =
    status === "ONLINE"
      ? t.offline.online
      : status === "OFFLINE"
        ? t.offline.offline
        : status === "SYNCING"
          ? t.offline.syncing
          : t.offline.syncComplete;

  return (
    <div
      role="status"
      aria-live="polite"
      data-status={status.toLowerCase()}
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium",
        status === "ONLINE" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        status === "OFFLINE" && "border-red-200 bg-red-50 text-red-700",
        status === "SYNCING" && "border-amber-200 bg-amber-50 text-amber-700",
        status === "SYNC_COMPLETE" && "border-blue-200 bg-blue-50 text-blue-700"
      )}
      title={pendingCount > 0 ? t.offline.pendingCount.replace("{count}", String(pendingCount)) : label}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          status === "ONLINE" && "bg-emerald-500",
          status === "OFFLINE" && "bg-red-500",
          status === "SYNCING" && "animate-pulse bg-amber-500",
          status === "SYNC_COMPLETE" && "bg-blue-500"
        )}
      />
      <span className="hidden sm:inline">{label}</span>
      {pendingCount > 0 && (
        <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">
          {pendingCount}
        </span>
      )}
    </div>
  );
}
