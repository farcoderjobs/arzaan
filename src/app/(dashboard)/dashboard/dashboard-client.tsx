"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { StatCard, ChartCard, LineChart, BarChart, DonutChart } from "@/components/charts";
import { money } from "@/components/report-shell";
import { RefreshCw } from "@/components/ui/icons";
import { error } from "@/utils/toast";
import { useT } from "@/i18n/client";
import { cn } from "@/utils/classname";

interface DashboardClientProps {
  userName: string;
  canSeeProfit: boolean;
  canSeeExpenses: boolean;
}

interface TodayKpis {
  sales: number;
  transactions: number;
  grossProfit: number | null;
  netProfit: number | null;
  expenses: number | null;
  /** Approved refunds in the window — already subtracted from `sales`. */
  refunds?: number;
  cashSales: number;
  cardSales: number;
  creditSales: number;
}

interface ChartPoint {
  day: string;
  revenue: number;
  count: number;
  cash: number;
  card: number;
  credit: number;
  cogs: number;
  grossProfit: number | null;
  profit: number | null;
}

interface DashboardData {
  today: TodayKpis;
  /** KPIs for the selected date range (equals `today` when days === 1). */
  range: TodayKpis;
  receivables: number | null;
  payables: number | null;
  stock: { lowStockCount: number; outOfStock: number; lowStock: Array<{ id: string; name: string; stock: number; reorderPoint: number }> } | null;
  topProducts: Array<{ name: string; quantity: number; revenue: number }>;
  recentSales: Array<{ id: string; invoiceNumber: string; total: number; paymentMethod: string | null; createdAt: string; cashierName: string | null }>;
  categorySplit: Array<{ name: string; revenue: number }>;
  chart: ChartPoint[];
  canSeeProfit: boolean;
}

export function DashboardClient({ userName, canSeeProfit, canSeeExpenses }: DashboardClientProps) {
  const tr = useT();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState("1");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard?days=${days}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      error("Error", "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // KPI cards must reflect the selected range, not always "today".
  const t = (days === "1" ? data?.today : data?.range) ?? data?.today ?? null;
  const chart = data?.chart ?? [];

  const ranges = useMemo(
    () => [
      { value: "1", label: tr.dashboard.today },
      { value: "7", label: tr.dashboard.range7 },
      { value: "14", label: tr.dashboard.range14 },
      { value: "30", label: tr.dashboard.range30 },
    ],
    [tr]
  );

  const paymentDonut = [
    { label: tr.pos.cash, value: chart.reduce((s, c) => s + c.cash, 0), color: "#16a34a" },
    { label: `${tr.pos.card} / ${tr.pos.transfer}`, value: chart.reduce((s, c) => s + c.card, 0), color: "#2563eb" },
    { label: tr.pos.credit, value: chart.reduce((s, c) => s + c.credit, 0), color: "#f59e0b" },
  ];

  const categoryColors = ["#2563eb", "#16a34a", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];

  return (
    <div className="mx-auto max-w-7xl">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 sm:mb-6">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
            {tr.auth.welcomeBack}, {userName.split(" ")[0]}
          </h1>
          <p className="mt-1 text-sm text-slate-500">{tr.dashboard.title}</p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <select
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 sm:flex-none"
          >
            {ranges.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <button
            onClick={load}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-600 shadow-sm transition hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" /> {tr.common.refresh}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : (
        <>
          {/* KPI grid */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label={days === "1" ? tr.dashboard.todaysSales : tr.sales.title} value={money(t?.sales ?? 0)} sub={`${t?.transactions ?? 0} ${tr.dashboard.todaysTransactions}`} tone="blue" icon="💰" />
            <StatCard label={tr.dashboard.todaysTransactions} value={String(t?.transactions ?? 0)} sub={days === "1" ? tr.reports.daily : `${days}d`} icon="🧾" />
            {canSeeProfit && t?.grossProfit !== null && t?.grossProfit !== undefined && (
              <StatCard label={days === "1" ? tr.dashboard.todaysProfit : tr.reports.grossProfit} value={money(t.grossProfit)} sub={`${tr.reports.revenue} − ${tr.reports.cogs}`} tone="green" icon="📈" />
            )}
            {canSeeProfit && t?.netProfit !== null && t?.netProfit !== undefined && (
              <StatCard
                label={days === "1" ? tr.dashboard.todaysNetProfit : tr.reports.netProfit}
                value={money(t.netProfit)}
                sub={canSeeExpenses && t.expenses !== null ? `after ${money(t.expenses)} expenses` : "after expenses"}
                tone={t.netProfit >= 0 ? "purple" : "red"}
                icon="🏦"
              />
            )}
            {canSeeExpenses && t?.expenses !== null && t?.expenses !== undefined && (
              <StatCard label={days === "1" ? tr.dashboard.todaysExpenses : tr.finance.expenses} value={money(t.expenses)} tone="red" icon="💸" />
            )}
            <StatCard label={`${tr.pos.cash} ${tr.sales.title}`} value={money(t?.cashSales ?? 0)} tone="green" icon="💵" />
            <StatCard label={`${tr.pos.card} ${tr.sales.title}`} value={money(t?.cardSales ?? 0)} tone="blue" icon="💳" />
            <StatCard label={`${tr.pos.credit} ${tr.sales.title}`} value={money(t?.creditSales ?? 0)} tone="amber" icon="📝" />
            <StatCard label={tr.dashboard.refunds} value={money(t?.refunds ?? 0)} tone="red" icon="↩️" />
          </div>

          {/* AR / AP / stock strip */}
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            {data?.receivables !== null && data?.receivables !== undefined && (
              <StatCard label={tr.dashboard.receivables} value={money(data.receivables)} tone="amber" />
            )}
            {data?.payables !== null && data?.payables !== undefined && (
              <StatCard label={tr.dashboard.payables} value={money(data.payables)} tone="amber" />
            )}
            {data?.stock && (
              <>
                <StatCard label={tr.dashboard.lowStock} value={String(data.stock.lowStockCount)} tone="amber" />
                <StatCard label={tr.dashboard.outOfStock} value={String(data.stock.outOfStock)} tone="red" />
              </>
            )}
          </div>

          {/* Charts */}
          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-4">
              <ChartCard title={tr.dashboard.salesOverTime}>
                <LineChart data={chart.map((c) => ({ label: c.day.slice(5), value: c.revenue }))} valueFormat={money} height={180} />
              </ChartCard>

              {data?.canSeeProfit && (
                <div className="grid gap-4 md:grid-cols-2">
                  <ChartCard title={tr.dashboard.revenueVsCogs}>
                    <LineChart
                      data={chart.map((c) => ({ label: c.day.slice(5), value: c.revenue }))}
                      secondary={chart.map((c) => ({ label: c.day.slice(5), value: c.cogs }))}
                      color="#2563eb"
                      secondaryColor="#ef4444"
                      valueFormat={money}
                      height={150}
                    />
                  </ChartCard>
                  <ChartCard title={tr.dashboard.profitOverTime}>
                    <LineChart
                      data={chart.map((c) => ({ label: c.day.slice(5), value: c.grossProfit ?? 0 }))}
                      secondary={chart.map((c) => ({ label: c.day.slice(5), value: c.profit ?? 0 }))}
                      color="#16a34a"
                      secondaryColor="#9333ea"
                      valueFormat={money}
                      height={150}
                    />
                  </ChartCard>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <ChartCard title={tr.dashboard.salesByCategory}>
                  <DonutChart
                    data={(data?.categorySplit ?? []).map((c, i) => ({ label: c.name, value: c.revenue, color: categoryColors[i % categoryColors.length] }))}
                    size={140}
                  />
                </ChartCard>
                <ChartCard title={tr.dashboard.paymentMethods}>
                  <DonutChart data={paymentDonut} size={140} />
                </ChartCard>
              </div>
            </div>

            {/* Side panels */}
            <div className="space-y-4">
              {data?.topProducts && data.topProducts.length > 0 && (
                <ChartCard title={tr.dashboard.topProducts}>
                  <ol className="space-y-2.5">
                    {data.topProducts.map((p, i) => (
                      <li key={i} className="flex items-center gap-3 text-sm">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-slate-700">{p.name}</span>
                        <span className="shrink-0 text-xs text-slate-400">{p.quantity} {tr.pos.qty}</span>
                      </li>
                    ))}
                  </ol>
                </ChartCard>
              )}

              {data?.stock && data.stock.lowStock.length > 0 && (
                <ChartCard title={tr.dashboard.lowStock}>
                  <ul className="space-y-2">
                    {data.stock.lowStock.slice(0, 6).map((p) => (
                      <li key={p.id} className="flex items-center justify-between text-sm">
                        <span className="min-w-0 flex-1 truncate text-slate-700">{p.name}</span>
                        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                          {p.stock} / {p.reorderPoint}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <Link href="/inventory" className="mt-3 block text-center text-xs font-medium text-blue-600 hover:underline">
                    {tr.nav.inventory} →
                  </Link>
                </ChartCard>
              )}
            </div>
          </div>

          {/* Recent sales */}
          {data?.recentSales && data.recentSales.length > 0 && (
            <div className="mt-6 rounded-2xl border border-slate-200/80 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-5">
                <h3 className="text-sm font-semibold text-slate-700">{tr.dashboard.recentSales}</h3>
                <Link href="/sales" className="text-xs font-medium text-blue-600 hover:underline">{tr.nav.sales} →</Link>
              </div>
              <ul className="divide-y divide-slate-100">
                {data.recentSales.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                    <div className="flex min-w-0 items-center gap-3">
                      <Link href={`/sales/${s.id}`} className="truncate font-mono text-xs font-medium text-blue-600 hover:underline">{s.invoiceNumber}</Link>
                      <span className="hidden text-xs text-slate-400 sm:inline">
                        {new Date(s.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                        {s.cashierName ? ` · ${s.cashierName}` : ""}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 sm:gap-3">
                      <span className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                        s.paymentMethod === "cash" ? "bg-green-100 text-green-700" :
                        s.paymentMethod === "credit" ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"
                      )}>
                        {s.paymentMethod ?? "—"}
                      </span>
                      <span className="font-semibold text-slate-900">{money(s.total)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Quick actions */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { href: "/pos", label: "New Sale", icon: "🛒" },
              { href: "/cash-register", label: "Cash Register", icon: "💵" },
              { href: "/finance", label: "Finance", icon: "💳" },
              { href: "/reports", label: "Reports", icon: "📈" },
            ].map((a) => (
              <Link
                key={a.href}
                href={a.href}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm font-medium text-slate-700 shadow-sm transition hover:border-blue-300 hover:shadow"
              >
                <span className="text-xl">{a.icon}</span>
                {a.label}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
