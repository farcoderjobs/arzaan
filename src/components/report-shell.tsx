"use client";

import { useCallback, useEffect, useState, ReactNode } from "react";
import { Button, Input, Select, Table, EmptyState, Pagination } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { StatCard, ChartCard } from "@/components/charts";
import { error } from "@/utils/toast";

export interface ReportShellProps<T> {
  title: string;
  description: string;
  /** API path, e.g. /api/reports/sales */
  endpoint: string;
  /** Extra static query params (e.g. { view: "low" }) */
  baseParams?: Record<string, string>;
  /** Optional secondary view switcher rendered as tabs */
  views?: Array<{ value: string; label: string }>;
  viewParam?: string;
  defaultView?: string;
  /** Additional filter slots rendered before dates */
  extraFilters?: ReactNode;
  columns: Array<{ key: string; header: string; render?: (row: T) => ReactNode; className?: string; align?: "left" | "right" }>;
  /** Map API rows to table rows */
  rows: (data: Record<string, unknown>) => T[];
  /** Row key extractor */
  rowKey: (row: T) => string;
  /** Summary stat cards from the API response */
  summary?: (data: Record<string, unknown>) => Array<{ label: string; value: string; sub?: string; tone?: "slate" | "green" | "red" | "blue" | "amber" | "purple" }>;
  /** Optional chart renderer */
  chart?: (data: Record<string, unknown>) => ReactNode;
  /** Response field that holds total rows for pagination (default "total") */
  totalField?: string;
  /** Hide pagination (aggregate-only reports) */
  hidePagination?: boolean;
  /** Hide CSV export button */
  hideCsv?: boolean;
}

const PERIODS = [
  { value: "", label: "Last 30 days" },
  { value: "day", label: "Today" },
  { value: "week", label: "This week (7d)" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom range" },
];

export function ReportShell<T>(props: ReportShellProps<T>) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [view, setView] = useState(props.defaultView ?? "");

  const perPage = 15;
  const baseParamsKey = JSON.stringify(props.baseParams ?? {});

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage), ...props.baseParams });
      if (props.viewParam && view) params.set(props.viewParam, view);
      if (period === "custom") {
        if (from) params.set("from", from);
        if (to) params.set("to", to);
      } else if (period) {
        params.set("period", period);
      }
      const res = await fetch(`${props.endpoint}?${params}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      error("Error", "Failed to load report");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, period, from, to, view, baseParamsKey, props.endpoint]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const exportCsv = () => {
    const params = new URLSearchParams({ format: "csv", ...props.baseParams });
    if (props.viewParam && view) params.set(props.viewParam, view);
    if (period === "custom") {
      if (from) params.set("from", from);
      if (to) params.set("to", to);
    } else if (period) {
      params.set("period", period);
    }
    fetch(`${props.endpoint}?${params}`)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error())))
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${props.endpoint.split("/").pop()}-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => error("Export failed", "Could not download CSV"));
  };

  const total = props.hidePagination ? 0 : Number((data?.[props.totalField ?? "total"] as number) ?? 0);

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Reports", href: "/reports" }, { label: props.title }]} />
      <PageHeader
        title={props.title}
        description={props.description}
        actions={
          !props.hideCsv && (
            <Button variant="secondary" onClick={exportCsv} disabled={loading}>
              Export CSV
            </Button>
          )
        }
      />

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-44">
          <label className="mb-1 block text-xs font-medium text-slate-500">Period</label>
          <Select value={period} onChange={(v) => { setPeriod(v); setPage(1); }} options={PERIODS} />
        </div>
        {period === "custom" && (
          <>
            <div className="w-40">
              <label className="mb-1 block text-xs font-medium text-slate-500">From</label>
              <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
            </div>
            <div className="w-40">
              <label className="mb-1 block text-xs font-medium text-slate-500">To</label>
              <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
            </div>
          </>
        )}
        {props.views && props.viewParam && (
          <div className="w-52">
            <label className="mb-1 block text-xs font-medium text-slate-500">View</label>
            <Select value={view} onChange={(v) => { setView(v); setPage(1); }} options={props.views} />
          </div>
        )}
        {props.extraFilters}
      </div>

      {/* Summary */}
      {props.summary && data && props.summary(data).length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {props.summary(data).map((s) => (
            <StatCard key={s.label} label={s.label} value={s.value} sub={s.sub} tone={s.tone} />
          ))}
        </div>
      )}

      {/* Chart */}
      {props.chart && data && (
        <div className="mb-4">
          <ChartCard title={props.title}>{props.chart(data)}</ChartCard>
        </div>
      )}

      {/* Table */}
      <Table
        columns={props.columns.map((c) => ({ key: c.key, header: c.header, className: c.align === "right" ? "text-right" : c.className, render: c.render ? (row: T) => c.render!(row) : undefined }))}
        data={data ? props.rows(data) : []}
        keyExtractor={props.rowKey}
        loading={loading}
        empty={<EmptyState label="No data for this range" description="Adjust filters or pick a different period." />}
      />

      {!props.hidePagination && Math.ceil(total / perPage) > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={Math.ceil(total / perPage)} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}

export { money } from "@/lib/currency";
