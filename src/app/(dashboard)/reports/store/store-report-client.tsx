"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Select } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { StatCard, ChartCard, LineChart, DonutChart } from "@/components/charts";
import { money } from "@/lib/currency";
import { error } from "@/utils/toast";
import { cn } from "@/utils/classname";

interface Summary {
  revenue: number;
  orders: number;
  units: number;
  avgOrder: number;
  uniqueCustomers: number;
  pending: number;
}

interface Data {
  summary: Summary;
  byStatus: Array<{ status: string; count: number; total: number }>;
  byDay: Array<{ day: string; revenue: number; orders: number }>;
  topProducts: Array<{ name: string; units: number; revenue: number }>;
  orders: Array<{
    id: string;
    orderNumber: string;
    customerName: string;
    phone: string;
    status: string;
    total: number;
    itemCount: number;
    createdAt: string;
  }>;
}

const PERIODS = [
  { value: "", label: "Last 30 days" },
  { value: "day", label: "Today" },
  { value: "week", label: "This week (7d)" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom range" },
];

const STATUS_CHIPS: Record<string, { label: string; chip: string }> = {
  pending: { label: "Pending", chip: "bg-amber-100 text-amber-700" },
  confirmed: { label: "Confirmed", chip: "bg-blue-100 text-blue-700" },
  shipped: { label: "Shipped", chip: "bg-violet-100 text-violet-700" },
  delivered: { label: "Delivered", chip: "bg-emerald-100 text-emerald-700" },
  canceled: { label: "Canceled", chip: "bg-slate-100 text-slate-500" },
};

const STATUS_COLORS: Record<string, string> = {
  pending: "#f59e0b",
  confirmed: "#3b82f6",
  shipped: "#8b5cf6",
  delivered: "#10b981",
  canceled: "#94a3b8",
};

export function StoreReportClient() {
  const [period, setPeriod] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  const buildParams = useCallback(
    (extra?: Record<string, string>) => {
      const params = new URLSearchParams(extra);
      if (period === "custom") {
        if (from) params.set("from", from);
        if (to) params.set("to", to);
      } else if (period) {
        params.set("period", period);
      }
      return params;
    },
    [period, from, to]
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/reports/store?${buildParams()}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      error("Error", "Failed to load the online store report");
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const exportCsv = () => {
    fetch(`/api/reports/store?${buildParams({ format: "csv" })}`)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error())))
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `store-report-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => error("Export failed", "Could not download CSV"));
  };

  const s = data?.summary;

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Reports", href: "/reports" }, { label: "Online Store" }]} />
      <PageHeader
        title="Online Store Report"
        description="Orders, revenue and best sellers from the public storefront (paid on delivery)"
        actions={
          <Button variant="secondary" onClick={exportCsv} disabled={loading}>
            Export CSV
          </Button>
        }
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
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Store revenue" value={money(s?.revenue ?? 0)} sub="Excl. canceled orders" tone="green" />
            <StatCard label="Orders" value={String(s?.orders ?? 0)} sub={`${s?.pending ?? 0} pending`} tone="blue" />
            <StatCard label="Units sold" value={String(s?.units ?? 0)} tone="purple" />
            <StatCard label="Avg order" value={money(s?.avgOrder ?? 0)} tone="amber" />
            <StatCard label="Customers" value={String(s?.uniqueCustomers ?? 0)} sub="Unique phone numbers" tone="slate" />
            <StatCard label="Pending" value={String(s?.pending ?? 0)} sub="Awaiting confirmation" tone={ (s?.pending ?? 0) > 0 ? "red" : "slate"} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <ChartCard title="Revenue over time">
                <LineChart data={(data?.byDay ?? []).map((d) => ({ label: d.day.slice(5), value: d.revenue }))} color="#10b981" valueFormat={money} />
              </ChartCard>
              <div className="mt-4">
                <ChartCard title="Orders per day">
                  <LineChart data={(data?.byDay ?? []).map((d) => ({ label: d.day.slice(5), value: d.orders }))} color="#6366f1" />
                </ChartCard>
              </div>
            </div>
            <ChartCard title="Orders by status">
              {(data?.byStatus ?? []).length === 0 ? (
                <div className="flex h-40 items-center justify-center text-sm text-slate-400">No orders in this range</div>
              ) : (
                <DonutChart
                  data={(data?.byStatus ?? []).map((r) => ({
                    label: STATUS_CHIPS[r.status]?.label ?? r.status,
                    value: r.count,
                    color: STATUS_COLORS[r.status] ?? "#94a3b8",
                  }))}
                />
              )}
            </ChartCard>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-700">Top products</h3>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-2.5">Product</th>
                    <th className="px-4 py-2.5 text-right">Units</th>
                    <th className="px-4 py-2.5 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(data?.topProducts ?? []).length === 0 && (
                    <tr><td colSpan={3} className="px-4 py-8 text-center text-slate-400">No product sales in this range</td></tr>
                  )}
                  {(data?.topProducts ?? []).map((p, i) => (
                    <tr key={`${p.name}-${i}`} className="transition hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-900">
                        <span className="mr-2 text-slate-400">{i + 1}.</span>
                        {p.name}
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-600">{p.units}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-slate-900">{money(p.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-700">Recent orders</h3>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-2.5">Order</th>
                    <th className="px-4 py-2.5">Customer</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(data?.orders ?? []).length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">No orders in this range</td></tr>
                  )}
                  {(data?.orders ?? []).map((o) => {
                    const meta = STATUS_CHIPS[o.status] ?? STATUS_CHIPS.pending;
                    return (
                      <tr key={o.id} className="transition hover:bg-slate-50">
                        <td className="px-4 py-2.5">
                          <p className="font-mono text-xs font-semibold text-slate-900">{o.orderNumber}</p>
                          <p className="text-[11px] text-slate-400">{new Date(o.createdAt).toLocaleDateString()}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="font-medium text-slate-900">{o.customerName}</p>
                          <p className="text-[11px] text-slate-500">{o.phone}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", meta.chip)}>{meta.label}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-semibold text-slate-900">{money(o.total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
