"use client";

import { useCallback, useEffect, useState } from "react";
import { Table, EmptyState, Pagination, Button, Select } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { StatCard, ChartCard, BarChart } from "@/components/charts";
import { money } from "@/components/report-shell";
import { error } from "@/utils/toast";
import { cn } from "@/utils/classname";

type View = "expenses" | "cashflow" | "receivables" | "payables";

const VIEWS: Array<{ value: View; label: string }> = [
  { value: "expenses", label: "Expenses" },
  { value: "cashflow", label: "Cash flow" },
  { value: "receivables", label: "Customer receivables" },
  { value: "payables", label: "Supplier payables" },
];

const PERIODS = [
  { value: "", label: "Last 30 days" },
  { value: "day", label: "Today" },
  { value: "week", label: "This week (7d)" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom range" },
];

export function FinanceReportClient() {
  const [view, setView] = useState<View>("expenses");
  const [period, setPeriod] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams({ view });
      if (period === "custom") {
        if (from) params.set("from", from);
        if (to) params.set("to", to);
      } else if (period) {
        params.set("period", period);
      }
      const res = await fetch(`/api/reports/finance?${params}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      error("Error", "Failed to load finance report");
    } finally {
      setLoading(false);
    }
  }, [view, period, from, to]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const exportCsv = () => {
    const params = new URLSearchParams({ view, format: "csv" });
    if (period === "custom") {
      if (from) params.set("from", from);
      if (to) params.set("to", to);
    } else if (period) {
      params.set("period", period);
    }
    fetch(`/api/reports/finance?${params}`)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error())))
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `finance-${view}-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => error("Export failed", "Could not download CSV"));
  };

  const summary = (data?.summary ?? {}) as Record<string, number>;
  const byCategory = ((data?.byCategory as Array<{ category: string; total: number; count: number }>) ?? []);
  const byDay = ((data?.byDay as Array<{ day: string; total?: number; inflow?: number; outflow?: number; net?: number }>) ?? []);
  const rows = ((data?.rows as Array<{ _id: string; name: string; balance: number }>) ?? []);

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Reports", href: "/reports" }, { label: "Finance" }]} />
      <PageHeader
        title="Finance Report"
        description="Expenses, cash flow, receivables and payables"
        actions={<Button variant="secondary" onClick={exportCsv} disabled={loading}>Export CSV</Button>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-52">
          <label className="mb-1 block text-xs font-medium text-slate-500">Section</label>
          <Select value={view} onChange={(v) => setView(v as View)} options={VIEWS} />
        </div>
        <div className="w-44">
          <label className="mb-1 block text-xs font-medium text-slate-500">Period</label>
          <Select value={period} onChange={setPeriod} options={PERIODS} />
        </div>
        {period === "custom" && (
          <>
            <div className="w-40">
              <label className="mb-1 block text-xs font-medium text-slate-500">From</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div className="w-40">
              <label className="mb-1 block text-xs font-medium text-slate-500">To</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </div>
          </>
        )}
      </div>

      {loading ? (
        <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
      ) : (
        <>
          {/* Summary */}
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
            {view === "expenses" && (
              <>
                <StatCard label="Total expenses" value={money(summary.total ?? 0)} tone="red" />
                <StatCard label="Records" value={String(summary.count ?? 0)} />
              </>
            )}
            {view === "cashflow" && (
              <>
                <StatCard label="Cash in" value={money(summary.inflow ?? 0)} tone="green" />
                <StatCard label="Cash out" value={money(summary.outflow ?? 0)} tone="red" />
                <StatCard label="Net cash" value={money(summary.net ?? 0)} tone="blue" />
              </>
            )}
            {view === "receivables" && <StatCard label="Customer receivables" value={money(summary.totalReceivables ?? 0)} tone="amber" />}
            {view === "payables" && <StatCard label="Supplier payables" value={money(summary.totalPayables ?? 0)} tone="amber" />}
          </div>

          {/* Charts / category table */}
          {view === "expenses" && (
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <ChartCard title="Expenses by day">
                <BarChart data={byDay.map((d) => ({ label: (d.day ?? "").slice(5), value: d.total ?? 0 }))} color="#ef4444" valueFormat={money} />
              </ChartCard>
              <ChartCard title="Expenses by category">
                <ul className="space-y-2">
                  {byCategory.length === 0 && <li className="text-sm text-slate-400">No expenses in range</li>}
                  {byCategory.map((c) => {
                    const max = Math.max(...byCategory.map((x) => x.total), 1);
                    return (
                      <li key={c.category}>
                        <div className="flex justify-between text-sm">
                          <span className="capitalize text-slate-600">{c.category}</span>
                          <span className="font-semibold text-slate-900">{money(c.total)}</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                          <div className="h-1.5 rounded-full bg-red-500" style={{ width: `${(c.total / max) * 100}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </ChartCard>
            </div>
          )}

          {view === "cashflow" && (
            <div className="mb-4">
              <ChartCard title="Daily net cash flow">
                <BarChart data={byDay.map((d) => ({ label: (d.day ?? "").slice(5), value: d.net ?? 0 }))} color="#2563eb" valueFormat={money} />
              </ChartCard>
            </div>
          )}

          {/* Balances tables */}
          {(view === "receivables" || view === "payables") && (
            <Table
              columns={[
                { key: "name", header: view === "receivables" ? "Customer" : "Supplier" },
                {
                  key: "balance",
                  header: "Outstanding",
                  className: "text-right",
                  render: (r: { balance: number }) => <span className="font-semibold text-red-600">{money(r.balance)}</span>,
                },
              ]}
              data={rows}
              keyExtractor={(r) => r._id}
              empty={<EmptyState label="No outstanding balances" description="Everyone is settled up in this view." />}
            />
          )}

          {/* Expenses daily table */}
          {view === "expenses" && (
            <Table
              columns={[
                { key: "day", header: "Day" },
                { key: "total", header: "Expenses", className: "text-right", render: (r: { total?: number }) => money(r.total ?? 0) },
              ]}
              data={byDay.map((d) => ({ ...d, _id: d.day }))}
              keyExtractor={(r) => r._id}
              empty={<EmptyState label="No expenses in this range" />}
            />
          )}

          {/* Cashflow daily table */}
          {view === "cashflow" && (
            <Table
              columns={[
                { key: "day", header: "Day" },
                { key: "inflow", header: "In", className: "text-right", render: (r: { inflow?: number }) => <span className="text-green-700">{money(r.inflow ?? 0)}</span> },
                { key: "outflow", header: "Out", className: "text-right", render: (r: { outflow?: number }) => <span className="text-red-600">{money(r.outflow ?? 0)}</span> },
                { key: "net", header: "Net", className: "text-right", render: (r: { net?: number }) => (
                  <span className={cn("font-semibold", (r.net ?? 0) < 0 ? "text-red-600" : "text-slate-900")}>{money(r.net ?? 0)}</span>
                ) },
              ]}
              data={byDay.map((d) => ({ ...d, _id: d.day }))}
              keyExtractor={(r) => r._id}
              empty={<EmptyState label="No cash movements in this range" />}
            />
          )}
        </>
      )}
    </div>
  );
}
