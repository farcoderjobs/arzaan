"use client";

import { useState } from "react";
import { ReportShell, money } from "@/components/report-shell";
import { BarChart } from "@/components/charts";
import { Select } from "@/components/ui";

interface Row {
  _id: string;
  label: string;
  revenue: number;
  netRevenue: number;
  refunds?: number;
  quantity: number | null;
  count: number | null;
  /** Flavour/barcode grouping extras. */
  productName?: string;
  flavour?: string;
  barcode?: string;
  sku?: string;
}

const GROUPS = [
  { value: "day", label: "By day" },
  { value: "cashier", label: "By cashier" },
  { value: "customer", label: "By customer" },
  { value: "paymentMethod", label: "By payment method" },
  { value: "category", label: "By category" },
  { value: "flavour", label: "By flavour / barcode" },
];

export function SalesReportClient() {
  const [groupBy, setGroupBy] = useState("day");

  return (
    <ReportShell<Row>
      title="Sales Report"
      description="Revenue by day, cashier, customer, payment method, category or flavour/barcode — net of approved refunds"
      endpoint="/api/reports/sales"
      baseParams={{ groupBy }}
      hideCsv={false}
      extraFilters={
        <div className="w-52">
          <label className="mb-1 block text-xs font-medium text-slate-500">Group by</label>
          <Select value={groupBy} onChange={setGroupBy} options={GROUPS} />
        </div>
      }
      rows={(data) => (data.rows as Row[]) ?? []}
      rowKey={(r) => r._id}
      summary={(data) => {
        const s = (data.summary ?? {}) as Record<string, number>;
        return [
          { label: "Net sales", value: money(s.netSales ?? s.revenue ?? 0), tone: "blue" },
          { label: "Transactions", value: String(s.count ?? 0) },
          { label: "Average ticket", value: money(s.avgTicket ?? 0) },
          { label: "Refunds", value: money(s.refunds ?? 0), tone: "red", sub: `${s.returnsCount ?? 0} returned` },
          { label: "Discounts given", value: money(s.discounts ?? 0), tone: "amber" },
        ];
      }}
      chart={(data) => {
        const rows = ((data.rows as Row[]) ?? []).slice(0, 30);
        return <BarChart data={rows.map((r) => ({ label: r.label, value: r.revenue }))} valueFormat={money} />;
      }}
      columns={
        groupBy === "flavour"
          ? [
              { key: "productName", header: "Product" },
              { key: "flavour", header: "Flavour", render: (r: Row) => r.flavour || "—" },
              {
                key: "barcode",
                header: "Barcode",
                render: (r: Row) =>
                  r.barcode ? <span className="font-mono text-xs">{r.barcode}</span> : "—",
              },
              {
                key: "quantity",
                header: "Sold",
                align: "right" as const,
                render: (r: Row) => String(r.quantity ?? 0),
              },
              { key: "revenue", header: "Revenue", align: "right" as const, render: (r: Row) => money(r.revenue) },
            ]
          : [
              { key: "label", header: "Group" },
              { key: "revenue", header: "Revenue", align: "right", render: (r) => money(r.revenue) },
              { key: "netRevenue", header: "Net (after disc.)", align: "right", render: (r) => money(r.netRevenue) },
              ...(groupBy === "day"
                ? [{ key: "refunds", header: "Refunds", align: "right" as const, render: (r: Row) => ((r.refunds ?? 0) > 0 ? <span className="text-red-600">−{money(r.refunds ?? 0)}</span> : <span className="text-slate-300">—</span>) }]
                : []),
              { key: "count", header: "Transactions", align: "right", render: (r) => (r.count !== null ? String(r.count) : "—") },
            ]
      }
    />
  );
}
