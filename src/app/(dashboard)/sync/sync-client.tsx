"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Modal, Table, Textarea } from "@/components/ui";
import { PageHeader } from "@/components/ui/page-header";
import { useT } from "@/i18n/client";
import { cn } from "@/utils/classname";
import { apiErrorMessage } from "@/lib/api";
import { useSyncStatus } from "@/lib/sync/use-sync-status";
import { describeSyncState } from "@/lib/sync/status-types";
import type {
  SyncConflictView,
  SyncOutboxRowView,
  SyncRunSummary,
} from "@/lib/sync/status-types";
import { success, error as toastError } from "@/utils/toast";

/**
 * Sync Center.
 *
 * Shows the shop node's queue: what is waiting for the center, what failed, what
 * conflicted and what each run did. The buttons map onto the node's sync API —
 * the browser never touches the queue directly, it only reports on it.
 */

interface SyncClientProps {
  canSync: boolean;
  canManage: boolean;
}

function rowStatusClass(status: SyncOutboxRowView["status"]): string {
  switch (status) {
    case "SYNCED":
      return "bg-emerald-100 text-emerald-700";
    case "PENDING":
      return "bg-slate-100 text-slate-600";
    case "SENDING":
      return "bg-blue-100 text-blue-700";
    case "FAILED":
      return "bg-red-100 text-red-700";
  }
}

export function SyncClient({ canSync, canManage }: SyncClientProps) {
  const t = useT();
  const { status, loading: statusLoading, error: statusError, refresh } = useSyncStatus({
    pollMs: 10_000,
  });

  const [rows, setRows] = useState<SyncOutboxRowView[]>([]);
  const [conflicts, setConflicts] = useState<SyncConflictView[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [lastRun, setLastRun] = useState<SyncRunSummary | null>(null);
  const [dismissing, setDismissing] = useState<SyncConflictView | null>(null);
  const [dismissReason, setDismissReason] = useState("");

  const load = useCallback(async () => {
    try {
      const [outboxRes, conflictsRes] = await Promise.all([
        fetch("/api/sync/outbox", { cache: "no-store" }),
        fetch("/api/sync/conflicts", { cache: "no-store" }),
      ]);
      if (outboxRes.ok) {
        const body = await outboxRes.json();
        setRows(body?.data?.rows ?? []);
      }
      if (conflictsRes.ok) {
        const body = await conflictsRes.json();
        setConflicts(body?.data?.conflicts ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Anything the worker changes (a run, a retry, a conflict) lands in the rows.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [status?.counts.pending, status?.counts.failed, status?.counts.conflicts, load]);

  const state = describeSyncState(status);
  const counts = status?.counts ?? { pending: 0, sending: 0, failed: 0, synced: 0, conflicts: 0 };

  const post = async (path: string, init?: RequestInit) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...init,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(apiErrorMessage(body, `HTTP ${res.status}`));
    return body;
  };

  const handleSyncNow = async () => {
    setWorking(true);
    try {
      const body = await post("/api/sync/run");
      const summary = body?.data as SyncRunSummary | undefined;
      if (summary) {
        setLastRun(summary);
        if (summary.conflicted > 0 || summary.failed > 0) {
          toastError(t.offline.error, summary.message);
        } else {
          success(t.offline.syncComplete, summary.message);
        }
      }
      await Promise.all([load(), refresh()]);
    } catch (err) {
      toastError(t.offline.error, err instanceof Error ? err.message : t.offline.localServerError);
    } finally {
      setWorking(false);
    }
  };

  const handleRetryAll = async () => {
    setWorking(true);
    try {
      const res = await fetch("/api/sync/conflicts", { method: "PUT" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(apiErrorMessage(body, `HTTP ${res.status}`));
      await post("/api/sync/run");
      await Promise.all([load(), refresh()]);
      success(t.offline.syncCenter, t.common.refresh);
    } catch (err) {
      toastError(t.offline.error, err instanceof Error ? err.message : t.offline.localServerError);
    } finally {
      setWorking(false);
    }
  };

  const handleRetry = async (conflict: SyncConflictView) => {
    setWorking(true);
    try {
      await post("/api/sync/conflicts", {
        body: JSON.stringify({ action: "retry", conflictKey: conflict.conflictKey }),
      });
      await post("/api/sync/run");
      await Promise.all([load(), refresh()]);
    } catch (err) {
      toastError(t.offline.error, err instanceof Error ? err.message : t.offline.localServerError);
    } finally {
      setWorking(false);
    }
  };

  const handleDismiss = async () => {
    if (!dismissing) return;
    setWorking(true);
    try {
      await post("/api/sync/conflicts", {
        body: JSON.stringify({
          action: "dismiss",
          conflictKey: dismissing.conflictKey,
          reason: dismissReason.trim() || "Set aside by operator",
        }),
      });
      setDismissing(null);
      setDismissReason("");
      await Promise.all([load(), refresh()]);
      success(t.offline.syncCenter, t.offline.setAside);
    } catch (err) {
      toastError(t.offline.error, err instanceof Error ? err.message : t.offline.localServerError);
    } finally {
      setWorking(false);
    }
  };

  const handleReconcile = async () => {
    setWorking(true);
    try {
      const body = await post("/api/sync/resync");
      success(t.offline.reconcile, `${body?.data?.marked ?? 0} ${t.offline.documents}`);
      await Promise.all([load(), refresh()]);
    } catch (err) {
      toastError(t.offline.error, err instanceof Error ? err.message : t.offline.localServerError);
    } finally {
      setWorking(false);
    }
  };

  const stat = (label: string, value: number, tone: string) => (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cn("mt-1 text-2xl font-bold tabular-nums", tone)}>{value}</p>
    </div>
  );

  const queueColumns = [
    {
      key: "entity",
      header: t.offline.entity,
      render: (row: SyncOutboxRowView) => (
        <span className="font-medium text-slate-800">
          {row.entityType || row.collection}
          <span className="ms-2 font-mono text-[11px] text-slate-400">{row.docId.slice(-6)}</span>
        </span>
      ),
    },
    { key: "operation", header: t.common.status, render: (row: SyncOutboxRowView) => row.operation },
    {
      key: "status",
      header: t.common.status,
      render: (row: SyncOutboxRowView) => (
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", rowStatusClass(row.status))}>
          {row.status}
        </span>
      ),
    },
    { key: "attempts", header: t.offline.attempts, render: (row: SyncOutboxRowView) => row.attempts },
    {
      key: "date",
      header: t.common.date,
      render: (row: SyncOutboxRowView) => new Date(row.updatedAt).toLocaleString(),
    },
    {
      key: "error",
      header: t.offline.error,
      render: (row: SyncOutboxRowView) => (
        <span className="block max-w-[240px] truncate text-xs text-red-600" title={row.lastError ?? ""}>
          {row.lastError ?? "—"}
        </span>
      ),
    },
  ];

  const conflictColumns = [
    { key: "entity", header: t.offline.entity, render: (c: SyncConflictView) => c.entityType || c.collection },
    { key: "kind", header: t.common.status, render: (c: SyncConflictView) => c.kind },
    {
      key: "message",
      header: t.offline.error,
      render: (c: SyncConflictView) => (
        <span className="block max-w-[320px] truncate" title={c.message}>
          {c.message}
        </span>
      ),
    },
    {
      key: "date",
      header: t.common.date,
      render: (c: SyncConflictView) => new Date(c.createdAt).toLocaleString(),
    },
    {
      key: "actions",
      header: t.common.actions,
      render: (c: SyncConflictView) =>
        canManage || canSync ? (
          <div className="flex gap-2">
            {c.retryable && (
              <Button size="sm" variant="secondary" disabled={working} onClick={() => void handleRetry(c)}>
                {t.common.retry}
              </Button>
            )}
            {canManage && (
              <Button size="sm" variant="secondary" disabled={working} onClick={() => setDismissing(c)}>
                {t.offline.setAside}
              </Button>
            )}
          </div>
        ) : null,
    },
  ];

  return (
    <div data-sync-center>
      <PageHeader
        title={t.offline.syncCenter}
        description={t.offline.offlineBanner}
        actions={
          <>
            <Button variant="secondary" onClick={() => void Promise.all([load(), refresh()])}>
              {t.common.refresh}
            </Button>
            {canManage && (
              <Button variant="secondary" disabled={working} onClick={() => void handleReconcile()}>
                {t.offline.reconcile}
              </Button>
            )}
            {canSync && conflicts.length > 0 && (
              <Button variant="secondary" disabled={working} onClick={() => void handleRetryAll()}>
                {t.offline.retryAll}
              </Button>
            )}
            {canSync && (
              <Button
                disabled={working || !status?.pushEnabled}
                loading={working}
                onClick={() => void handleSyncNow()}
              >
                {t.offline.syncNow}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span
          data-sync-state={state.toLowerCase()}
          className={cn(
            "h-2.5 w-2.5 rounded-full",
            state === "ONLINE" && "bg-emerald-500",
            state === "OFFLINE" && "bg-amber-500",
            state === "SYNCING" && "animate-pulse bg-blue-500",
            state === "SYNC_COMPLETE" && "bg-emerald-500",
            state === "UNCONFIGURED" && "bg-slate-400"
          )}
        />
        <span className="font-medium text-slate-700">
          {state === "ONLINE"
            ? t.offline.online
            : state === "OFFLINE"
              ? t.offline.centerUnreachable
              : state === "SYNCING"
                ? t.offline.syncing
                : state === "SYNC_COMPLETE"
                  ? t.offline.syncComplete
                  : t.offline.notConfigured}
        </span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-500">
          {t.offline.lastSync}:{" "}
          {status?.connectivity.lastSuccessAt
            ? new Date(status.connectivity.lastSuccessAt).toLocaleTimeString()
            : t.offline.never}
        </span>
      </div>

      {status && status.localDatabaseConfigured && status.databaseMode === "fallback" && (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <p className="font-semibold">The local database is not running</p>
          <p className="mt-1">
            This server is using the online database instead, and replication is paused. Start MongoDB on this
            PC (the instance Compass opens), then restart the app so sales go back into the local database.
          </p>
        </div>
      )}
      {status && status.databaseMode === "local" && (
        <div className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          Working on the local shop database — sales and purchases are stored on this PC and sync to the online
          database when you press Sync now.
        </div>
      )}

      {statusError && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          {t.offline.localServerError}
        </div>
      )}

      {status && !status.pushEnabled && (
        <div className="mb-4 rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <p className="font-medium">{t.offline.notConfigured}</p>
          {status.missing.length > 0 && (
            <p className="mt-1 font-mono text-xs text-slate-500">{status.missing.join(", ")}</p>
          )}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stat(t.offline.pendingChanges, counts.pending + counts.sending, "text-slate-900")}
        {stat(t.offline.statusFailed, counts.failed, counts.failed > 0 ? "text-red-600" : "text-slate-900")}
        {stat(t.offline.conflicts, counts.conflicts, counts.conflicts > 0 ? "text-amber-600" : "text-slate-900")}
        {stat(t.offline.statusSynced, counts.synced, "text-emerald-600")}
      </div>

      {status && (
        <div className="mb-6 grid gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
          <div className="space-y-1 text-sm">
            <p className="font-semibold text-slate-900">{t.offline.node}</p>
            <p className="text-slate-600">
              {t.offline.nodeId}: <span className="font-mono">{status.nodeId || "—"}</span>
            </p>
            <p className="text-slate-600">
              {t.offline.role}: <span className="font-mono">{status.role}</span>
            </p>
            <p className="truncate text-slate-600" title={status.onlineUrl ?? ""}>
              {t.offline.center}:{" "}
              <span className="font-mono">
                {status.transport === "direct"
                  ? "online database (direct)"
                  : status.onlineUrl ?? "—"}
              </span>
            </p>
            {status.connectivity.lastError && (
              <p className="text-amber-700">
                {t.offline.lastError}: {status.connectivity.lastError.message}
              </p>
            )}
          </div>
          <div className="space-y-1 text-sm">
            <p className="font-semibold text-slate-900">{t.offline.localDatabase}</p>
            <p className="text-slate-600">
              {t.offline.databaseName}: <span className="font-mono">{status.localDb.dbName ?? "—"}</span>
            </p>
            <p className="text-slate-600">
              {t.offline.schemaVersion}: <span className="font-mono">{status.schemaVersion}</span>
            </p>
            <p className={status.localDb.transactionsSupported === false ? "text-amber-700" : "text-slate-600"}>
              {status.localDb.transactionsSupported === false
                ? t.offline.transactionsUnsupported
                : t.offline.transactionsSupported}
            </p>
            {status.trackingError && (
              <p className="text-amber-700">
                {t.offline.trackingWarning}: {status.trackingError.message}
              </p>
            )}
          </div>
        </div>
      )}

      {lastRun && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <p className="font-semibold text-slate-900">{t.offline.runSummary}</p>
          <p className="mt-1 text-slate-600">{lastRun.message}</p>
          <p className="mt-1 text-xs text-slate-500">
            {t.offline.pushed}: {lastRun.pushed} · {t.offline.conflicts}: {lastRun.conflicted} ·{" "}
            {t.offline.statusFailed}: {lastRun.failed} · {t.offline.pendingChanges}: {lastRun.remaining} ·{" "}
            {t.offline.pulled}: {lastRun.pulled}
          </p>
        </div>
      )}

      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-900">{t.offline.pendingChanges}</h2>
        <Table
          columns={queueColumns}
          data={rows}
          keyExtractor={(row) => row.rowKey}
          loading={loading || statusLoading}
          empty={<EmptyState label={t.offline.emptyQueue} />}
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-900">{t.offline.conflicts}</h2>
        <Table
          columns={conflictColumns}
          data={conflicts}
          keyExtractor={(row) => row.conflictKey}
          empty={<EmptyState label={t.common.noData} />}
        />
      </div>

      <Modal
        open={dismissing !== null}
        onClose={() => setDismissing(null)}
        title={t.offline.setAside}
        size="sm"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setDismissing(null)}>
            {t.common.cancel}
          </Button>,
          <Button key="ok" loading={working} onClick={() => void handleDismiss()}>
            {t.common.confirm}
          </Button>,
        ]}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">{dismissing?.message}</p>
          <Textarea
            value={dismissReason}
            onChange={(e) => setDismissReason(e.target.value)}
            placeholder={t.offline.setAsideReason}
            rows={3}
          />
        </div>
      </Modal>
    </div>
  );
}
