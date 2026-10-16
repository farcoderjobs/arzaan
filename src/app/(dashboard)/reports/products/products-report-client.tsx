"use client";

import { ReportShell, money } from "@/components/report-shell";

interface Row {
  _id: string;
  name: string;
  sku: string;
  quantitySold: number;
  returnedQty?: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  margin: number | null;
  lastSoldAt: string | null;
  orders: number;
}

const VIEWS = [
  { value: "sold", label: "All sold (by revenue)" },
  { value: "best", label: "Best selling" },
  { value: "slow", label: "Slow moving" },
  { value: "never", label: "Never sold" },
];

export function ProductsReportClient() {
  return (
    <ReportShell<Row>
      title="Products Report"
      description="Quantity sold (net of returns), revenue, COGS (from historical sale cost) and gross profit"
      endpoint="/api/reports/products"
      viewParam="view"
      defaultView="sold"
      views={VIEWS}
      rows={(data) => (data.rows as Row[]) ?? []}
      rowKey={(r) => r._id}
      columns={[
        { key: "name", header: "Product", render: (r) => (
          <div>
            <p className="font-medium text-slate-900">{r.name}</p>
            <p className="text-xs text-slate-400">{r.sku}</p>
          </div>
        ) },
        { key: "quantitySold", header: "Qty sold", align: "right", render: (r) => (
          <div>
            <p>{String(r.quantitySold)}</p>
            {(r.returnedQty ?? 0) > 0 && <p className="text-[11px] text-red-500">{r.returnedQty} returned</p>}
          </div>
        ) },
        { key: "revenue", header: "Revenue", align: "right", render: (r) => money(r.revenue) },
        { key: "cogs", header: "COGS", align: "right", render: (r) => money(r.cogs) },
        { key: "grossProfit", header: "Gross profit", align: "right", render: (r) => (
          <span className={r.grossProfit < 0 ? "font-semibold text-red-600" : "font-semibold text-green-700"}>{money(r.grossProfit)}</span>
        ) },
        { key: "margin", header: "Margin", align: "right", render: (r) => (r.margin === null ? "—" : `${r.margin.toFixed(1)}%`) },
        { key: "lastSoldAt", header: "Last sold", render: (r) => (r.lastSoldAt ? new Date(r.lastSoldAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "Never") },
      ]}
    />
  );
}
