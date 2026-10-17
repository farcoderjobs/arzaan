"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Select } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { StatCard, ChartCard, LineChart, DonutChart } from "@/components/charts";
import { money } from "@/components/report-shell";
import { error } from "@/utils/toast";

interface DailyRow {
  day: string;
  revenue: number;
  refunds: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
}

interface Summary {
  revenue: number;
  grossRevenue: number;
  tax: number;
  refunds: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  salesCount: number;
  margin: number;
}

interface Data {
  summary: Summary;
  expensesByCategory: Array<{ category: string; total: number; count: number }>;
  daily: DailyRow[];
}

const PERIODS = [
  { value: "", label: "Last 30 days" },
  { value: "day", label: "Today" },
  { value: "week", label: "This week (7d)" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom range" },
];

export function ProfitReportClient() {
  const [period, setPeriod] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams();
      if (period === "custom") {
        if (from) params.set("from", from);
        if (to) params.set("to", to);
      } else if (period) {
        params.set("period", period);
      }
      const res = await fetch(`/api/reports/profit?${params}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      error("Error", "Failed to load profit report");
    } finally {
      setLoading(false);
    }
  }, [period, from, to]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const exportCsv = () => {
    const params = new URLSearchParams({ format: "csv" });
    if (period === "custom") {
      if (from) params.set("from", from);
      if (to) params.set("to", to);
    } else if (period) {
      params.set("period", period);
    }
    fetch(`/api/reports/profit?${params}`)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error())))
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `profit-report-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => error("Export failed", "Could not download CSV"));
  };

  const s = data?.summary;

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Reports", href: "/reports" }, { label: "Profit" }]} />
      <PageHeader
        title="Profit Report"
        description="Revenue − COGS = Gross Profit · Gross Profit − Expenses = Net Profit · Net of approved refunds"
        actions={<Button variant="secondary" onClick={exportCsv} disabled={loading}>Export CSV</Button>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
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
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label="Revenue (net)"
              value={money(s?.revenue ?? 0)}
              sub={`${s?.salesCount ?? 0} sales${(s?.refunds ?? 0) > 0 ? ` · ${money(s?.refunds ?? 0)} refunded` : ""}`}
              tone="blue"
            />
            <StatCard label="COGS" value={money(s?.cogs ?? 0)} sub="Historical sale cost" tone="amber" />
            <StatCard label="Gross profit" value={money(s?.grossProfit ?? 0)} sub={`${s?.margin ?? 0}% margin`} tone="green" />
            <StatCard
              label="Net profit"
              value={money(s?.netProfit ?? 0)}
              sub={`After ${money(s?.expenses ?? 0)} expenses`}
              tone={(s?.netProfit ?? 0) >= 0 ? "purple" : "red"}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <ChartCard title="Revenue vs COGS over time">
                <LineChart
                  data={(data?.daily ?? []).map((d) => ({ label: d.day.slice(5), value: d.revenue }))}
                  secondary={(data?.daily ?? []).map((d) => ({ label: d.day.slice(5), value: d.cogs }))}
                  valueFormat={money}
                />
              </ChartCard>
              <div className="mt-4">
                <ChartCard title="Profit over time (gross vs net)">
                  <LineChart
                    data={(data?.daily ?? []).map((d) => ({ label: d.day.slice(5), value: d.grossProfit }))}
                    secondary={(data?.daily ?? []).map((d) => ({ label: d.day.slice(5), value: d.netProfit }))}
                    color="#16a34a"
                    secondaryColor="#9333ea"
                    valueFormat={money}
                  />
                </ChartCard>
              </div>
            </div>
            <ChartCard title="Expenses by category">
              <DonutChart
                data={(data?.expensesByCategory ?? []).slice(0, 8).map((e, i) => ({
                  label: e.category[0].toUpperCase() + e.category.slice(1),
                  value: e.total,
                  color: ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#94a3b8"][i % 8],
                }))}
              />
            </ChartCard>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 text-left">Day</th>
                  <th className="px-4 py-3 text-right">Revenue</th>
                  <th className="px-4 py-3 text-right">Refunds</th>
                  <th className="px-4 py-3 text-right">COGS</th>
                  <th className="px-4 py-3 text-right">Gross profit</th>
                  <th className="px-4 py-3 text-right">Expenses</th>
                  <th className="px-4 py-3 text-right">Net profit</th>
                </tr>
              </thead>
              <tbody>
                {(data?.daily ?? []).length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No data for this range</td></tr>
                )}
                {(data?.daily ?? []).map((d) => (
                  <tr key={d.day} className="border-b border-slate-100">
                    <td className="px-4 py-2.5">{d.day}</td>
                    <td className="px-4 py-2.5 text-right">{money(d.revenue)}</td>
                    <td className={"px-4 py-2.5 text-right " + (d.refunds > 0 ? "text-red-600" : "text-slate-300")}>{d.refunds > 0 ? `−${money(d.refunds)}` : "—"}</td>
                    <td className="px-4 py-2.5 text-right text-slate-500">{money(d.cogs)}</td>
                    <td className="px-4 py-2.5 text-right font-medium text-green-700">{money(d.grossProfit)}</td>
                    <td className="px-4 py-2.5 text-right text-red-600">{money(d.expenses)}</td>
                    <td className={"px-4 py-2.5 text-right font-semibold " + (d.netProfit < 0 ? "text-red-600" : "text-slate-900")}>{money(d.netProfit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
