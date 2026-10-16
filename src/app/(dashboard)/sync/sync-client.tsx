"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Table } from "@/components/ui";
import { PageHeader } from "@/components/ui/page-header";
import { useT } from "@/i18n/client";
import { money } from "@/lib/currency";
import { cn } from "@/utils/classname";
import { useConnectivity } from "@/lib/offline/use-connectivity";
import { setPendingCount } from "@/lib/offline/connectivity";
import {
  countUnsynced,
  listConflicts,
  listQueue,
  resolveConflict,
  type QueuedSale,
  type SyncConflict,
} from "@/lib/offline/db";
import { isSyncRunning, retryAll, retryEntry, syncNow } from "@/lib/offline/sync-engine";
import { success, error as toastError } from "@/utils/toast";

interface SyncClientProps {
  canSync: boolean;
}

function statusT(t: ReturnType<typeof useT>, status: QueuedSale["status"]): string {
  switch (status) {
    case "PENDING":
      return t.offline.statusQueued;
    case "SYNCING":
      return t.offline.statusSyncing;
    case "SYNCED":
      return t.offline.statusSynced;
    case "FAILED":
      return t.offline.statusFailed;
  }
}

export function SyncClient({ canSync }: SyncClientProps) {
  const t = useT();
  const { status: connection } = useConnectivity();
  const [queue, setQueue] = useState<QueuedSale[]>([]);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [entries, conflictRows, unsynced] = await Promise.all([
      listQueue(),
      listConflicts(),
      countUnsynced(),
    ]);
    setQueue(entries);
    setConflicts(conflictRows);
    setPendingCount(unsynced);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Deferred one tick: loads from IndexedDB and then updates state — a timer
    // keeps the effect body itself free of synchronous setState (react-hooks/set-state-in-effect).
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // Refresh whenever connectivity changes (a background sync may finish).
  useEffect(() => {
    if (connection === "ONLINE" || connection === "SYNC_COMPLETE") {
      const t = setTimeout(() => {
        if (connection === "SYNC_COMPLETE") setLastSyncAt(Date.now());
        void load();
      }, 0);
      return () => clearTimeout(t);
    }
  }, [connection, load]);

  // Poll while a background run is active so statuses move in real time.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setRunning(isSyncRunning());
      void load();
    }, 800);
    return () => clearInterval(timer);
  }, [running, load]);

  const counts = {
    queued: queue.filter((q) => q.status === "PENDING" || q.status === "SYNCING").length,
    failed: queue.filter((q) => q.status === "FAILED").length,
    synced: queue.filter((q) => q.status === "SYNCED").length,
    conflicts: conflicts.filter((c) => !c.resolved).length,
  };

  const canAct = canSync && connection !== "OFFLINE" && !running;

  const handleSyncNow = async () => {
    setWorking(true);
    setRunning(true);
    try {
      const result = await syncNow({ force: true });
      if (result.synced > 0) {
        setLastSyncAt(Date.now());
        success(t.offline.syncComplete, `${result.synced} → ${t.offline.statusSynced}`);
      } else if (result.failed > 0) {
        toastError(t.offline.error, `${result.failed} ${t.offline.statusFailed}`);
      } else {
        success(t.offline.syncComplete, t.offline.emptyQueue);
      }
      await load();
    } finally {
      setWorking(false);
      setRunning(isSyncRunning());
    }
  };

  const handleRetryAll = async () => {
    setWorking(true);
    setRunning(true);
    try {
      await retryAll();
      await load();
    } finally {
      setWorking(false);
      setRunning(isSyncRunning());
    }
  };

  const handleRetry = async (entry: QueuedSale) => {
    setWorking(true);
    try {
      await retryEntry(entry.clientTransactionId, entry);
      await load();
      const result = await syncNow({ force: true });
      if (result.synced > 0) setLastSyncAt(Date.now());
      await load();
    } finally {
      setWorking(false);
    }
  };

  const handleResolveConflict = async (id: string) => {
    await resolveConflict(id);
    await load();
  };

  const stat = (label: string, value: number, tone: string) => (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cn("mt-1 text-2xl font-bold tabular-nums", tone)}>{value}</p>
    </div>
  );

  const queueColumns = [
    {
      key: "ref",
      header: t.common.reference,
      render: (row: QueuedSale) => (
        <span className="font-mono text-xs">{row.syncedInvoiceNumber ?? row.offlineRef}</span>
      ),
    },
    {
      key: "createdAt",
      header: t.common.date,
      render: (row: QueuedSale) => new Date(row.createdAt).toLocaleString(),
    },
    { key: "items", header: t.common.quantity, render: (row: QueuedSale) => row.itemCount },
    { key: "total", header: t.common.total, render: (row: QueuedSale) => money(row.total) },
    {
      key: "status",
      header: t.common.status,
      render: (row: QueuedSale) => (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            row.status === "SYNCED" && "bg-emerald-100 text-emerald-700",
            row.status === "PENDING" && "bg-slate-100 text-slate-600",
            row.status === "SYNCING" && "bg-amber-100 text-amber-700",
            row.status === "FAILED" && "bg-red-100 text-red-700"
          )}
        >
          {statusT(t, row.status)}
        </span>
      ),
    },
    { key: "attempts", header: t.offline.attempts, render: (row: QueuedSale) => row.attempts },
    {
      key: "next",
      header: t.offline.nextAttempt,
      render: (row: QueuedSale) => {
        if (row.status === "SYNCED") return "—";
        if (row.status === "FAILED") return t.offline.statusFailed;
        const waitSec = Math.max(0, Math.ceil((row.nextAttemptAt - Date.now()) / 1000));
        return waitSec > 0 ? t.offline.backoffWait.replace("{seconds}", String(waitSec)) : t.offline.statusQueued;
      },
    },
    {
      key: "error",
      header: t.offline.error,
      render: (row: QueuedSale) => (
        <span className="block max-w-[240px] truncate text-xs text-red-600" title={row.lastError ?? ""}>
          {row.lastError ?? "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: t.common.actions,
      render: (row: QueuedSale) =>
        canSync && row.status === "FAILED" ? (
          <Button size="sm" variant="secondary" disabled={working} onClick={() => void handleRetry(row)}>
            {t.common.retry}
          </Button>
        ) : null,
    },
  ];

  const conflictColumns = [
    { key: "kind", header: t.common.status, render: (c: SyncConflict) => c.kind },
    {
      key: "message",
      header: t.offline.error,
      render: (c: SyncConflict) => (
        <span className="block max-w-[360px] truncate" title={c.message}>
          {c.message}
        </span>
      ),
    },
    { key: "date", header: t.common.date, render: (c: SyncConflict) => new Date(c.createdAt).toLocaleString() },
    {
      key: "resolve",
      header: t.common.actions,
      render: (c: SyncConflict) => (
        <Button size="sm" variant="secondary" onClick={() => void handleResolveConflict(c.id)}>
          {t.common.close}
        </Button>
      ),
    },
  ];

  return (
    <div data-sync-center>
      <PageHeader
        title={t.offline.syncCenter}
        description={t.offline.offlineBanner}
        actions={
          <>
            <Button variant="secondary" onClick={() => void load()}>{t.common.refresh}</Button>
            {canSync && counts.failed > 0 && (
              <Button variant="secondary" disabled={!canAct || working} onClick={() => void handleRetryAll()}>
                {t.offline.retryAll}
              </Button>
            )}
            {canSync && (
              <Button disabled={!canAct || working} loading={working} onClick={() => void handleSyncNow()}>
                {t.offline.syncNow}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 flex items-center gap-2 text-sm">
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full",
            connection === "ONLINE" && "bg-emerald-500",
            connection === "OFFLINE" && "bg-red-500",
            connection === "SYNCING" && "animate-pulse bg-amber-500",
            connection === "SYNC_COMPLETE" && "bg-blue-500"
          )}
        />
        <span className="font-medium text-slate-700">
          {connection === "ONLINE"
            ? t.offline.online
            : connection === "OFFLINE"
              ? t.offline.offline
              : connection === "SYNCING"
                ? t.offline.syncing
                : t.offline.syncComplete}
        </span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-500">
          {t.offline.lastSync}: {lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : t.offline.never}
        </span>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stat(t.offline.queuedSales, counts.queued, "text-slate-900")}
        {stat(t.offline.statusFailed, counts.failed, counts.failed > 0 ? "text-red-600" : "text-slate-900")}
        {stat(t.offline.statusSynced, counts.synced, "text-emerald-600")}
        {stat(t.offline.syncCenter, counts.conflicts, counts.conflicts > 0 ? "text-amber-600" : "text-slate-900")}
      </div>

      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-900">{t.offline.queuedSales}</h2>
        <Table
          columns={queueColumns}
          data={queue}
          keyExtractor={(row) => row.clientTransactionId}
          loading={loading}
          empty={<EmptyState label={t.offline.emptyQueue} />}
        />
      </div>

      {conflicts.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 font-semibold text-slate-900">{t.offline.error}</h2>
          <Table
            columns={conflictColumns}
            data={conflicts}
            keyExtractor={(row) => row.id}
            empty={<EmptyState label={t.common.noData} />}
          />
        </div>
      )}
    </div>
  );
}
