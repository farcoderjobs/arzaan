"use client";

import { useCallback, useEffect, useState } from "react";
import { SearchInput, Select, EmptyState, Button } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { Pagination } from "@/components/ui/pagination";
import { Download } from "@/components/ui/icons";
import { cn } from "@/utils/classname";

interface AuditRow {
  _id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  userId: string | null;
  userName: string;
  userEmail: string;
  branchName: string | null;
  changes: Record<string, { before?: unknown; after?: unknown }>;
  note: string | null;
  ip: string | null;
  createdAt: string;
}

const ENTITY_TYPES = [
  { value: "", label: "All entities" },
  { value: "User", label: "User" },
  { value: "Role", label: "Role" },
  { value: "Branch", label: "Branch" },
  { value: "Product", label: "Product" },
  { value: "Sale", label: "Sale" },
  { value: "Purchase", label: "Purchase" },
  { value: "SaleReturn", label: "Return" },
  { value: "Customer", label: "Customer" },
  { value: "Supplier", label: "Supplier" },
  { value: "CustomerTransaction", label: "Customer payment" },
  { value: "SupplierTransaction", label: "Supplier payment" },
  { value: "Expense", label: "Expense" },
  { value: "CashRegister", label: "Cash register" },
  { value: "InventoryMovement", label: "Inventory" },
  { value: "StoreSettings", label: "Settings" },
];

const PERIODS = [
  { value: "day", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "This month" },
];

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }
  return String(v);
}

export function AuditLogsClient() {
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage] = useState(25);
  const [period, setPeriod] = useState("week");
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [search, setSearch] = useState("");
  const [actions, setActions] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage), period });
      if (entityType) params.set("entityType", entityType);
      if (action) params.set("action", action);
      if (search) params.set("search", search);
      const res = await fetch(`/api/audit-logs?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setLogs(data.logs ?? []);
      setTotal(data.total ?? 0);
      setActions(data.actions ?? []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [page, perPage, period, entityType, action, search]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const totalPages = Math.ceil(total / perPage);

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Audit Logs" }]} />
      <PageHeader
        title="Audit Logs"
        description="Immutable record of every security-relevant action. Logs are append-only and cannot be edited."
        actions={
          <a
            href={`/api/audit-logs?format=csv&period=${period}${entityType ? `&entityType=${entityType}` : ""}${action ? `&action=${action}` : ""}`}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </a>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-[200px] flex-1">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search action, entity or note..."
            className="max-w-sm"
          />
        </div>
        <div className="w-40">
          <Select value={period} onChange={(v) => { setPeriod(v); setPage(1); }} options={PERIODS} className="w-full" />
        </div>
        <div className="w-44">
          <Select value={entityType} onChange={(v) => { setEntityType(v); setPage(1); }} options={ENTITY_TYPES} className="w-full" />
        </div>
        <div className="w-52">
          <Select
            value={action}
            onChange={(v) => { setAction(v); setPage(1); }}
            options={[{ value: "", label: "All actions" }, ...actions.map((a) => ({ value: a, label: a }))]}
            className="w-full"
          />
        </div>
      </div>

      {loading ? (
        <p className="py-10 text-center text-sm text-slate-400">Loading audit logs…</p>
      ) : logs.length === 0 ? (
        <EmptyState label="No audit entries" description="Actions in the selected range will appear here." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-4 py-3 font-semibold">Time</th>
                <th className="px-4 py-3 font-semibold">User</th>
                <th className="px-4 py-3 font-semibold">Action</th>
                <th className="px-4 py-3 font-semibold">Entity</th>
                <th className="px-4 py-3 font-semibold">Branch</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const hasChanges = log.changes && Object.keys(log.changes).length > 0;
                const isExpanded = expanded === log._id;
                return (
                  <>
                    <tr
                      key={log._id}
                      onClick={() => hasChanges && setExpanded(isExpanded ? null : log._id)}
                      className={cn("border-b border-slate-100 last:border-0", hasChanges && "cursor-pointer hover:bg-slate-50")}
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">{new Date(log.createdAt).toLocaleString()}</td>
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-slate-700">{log.userName}</p>
                        {log.userEmail && <p className="text-xs text-slate-400">{log.userEmail}</p>}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">{log.action}</span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {log.entityType}
                        {log.note && <p className="text-xs text-slate-400">{log.note}</p>}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500">{log.branchName ?? "—"}</td>
                    </tr>
                    {isExpanded && hasChanges && (
                      <tr key={`${log._id}-detail`} className="border-b border-slate-100 bg-slate-50/60 last:border-0">
                        <td colSpan={5} className="px-8 py-3">
                          <div className="space-y-1.5">
                            {Object.entries(log.changes).map(([field, change]) => (
                              <div key={field} className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="w-40 font-mono font-semibold text-slate-600">{field}</span>
                                <span className="rounded bg-red-50 px-2 py-0.5 text-red-700 line-through">{formatValue(change.before)}</span>
                                <span className="text-slate-400">→</span>
                                <span className="rounded bg-green-50 px-2 py-0.5 text-green-700">{formatValue(change.after)}</span>
                              </div>
                            ))}
                            {log.ip && <p className="pt-1 text-xs text-slate-400">IP: {log.ip}</p>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={totalPages} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
