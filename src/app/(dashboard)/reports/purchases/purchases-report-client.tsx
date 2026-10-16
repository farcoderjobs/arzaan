"use client";

import { ReportShell, money } from "@/components/report-shell";

interface SupplierRow { _id: string; name: string; total: number; paid: number; due: number; count: number; }
interface ProductRow { _id: string; name: string; sku: string; quantity: number; spend: number; }
interface OutstandingRow { _id: string; name: string; phone: string; balance: number; }

type Row = SupplierRow & ProductRow & OutstandingRow;

const VIEWS = [
  { value: "by-supplier", label: "By supplier" },
  { value: "by-product", label: "By product" },
  { value: "outstanding", label: "Outstanding balances" },
];

export function PurchasesReportClient() {
  return (
    <ReportShell<Row>
      title="Purchases Report"
      description="Total purchases, by supplier, by product and outstanding balances"
      endpoint="/api/reports/purchases"
      viewParam="view"
      defaultView="by-supplier"
      views={VIEWS}
      summary={(data) => {
        const s = (data.summary ?? {}) as Record<string, number>;
        const view = String(data.view ?? "");
        if (view === "outstanding") return [{ label: "Total outstanding", value: money(s.totalOutstanding ?? 0), tone: "red" }];
        if (view === "by-product") return [{ label: "Total spend", value: money(s.spend ?? 0), tone: "blue" }];
        return [
          { label: "Total purchases", value: money(s.total ?? 0), tone: "blue" },
          { label: "Outstanding", value: money(s.due ?? 0), tone: "red" },
          { label: "Orders", value: String(s.count ?? 0) },
        ];
      }}
      rows={(data) => ((data.rows as Row[]) ?? [])}
      rowKey={(r) => r._id}
      columns={[
        { key: "name", header: "Supplier / Product", render: (r) => (
          <div>
            <p className="font-medium text-slate-900">{r.name}</p>
            {r.sku ? <p className="text-xs text-slate-400">{r.sku}</p> : r.phone ? <p className="text-xs text-slate-400">{r.phone}</p> : null}
          </div>
        ) },
        { key: "total", header: "Purchases", align: "right", render: (r) => money(r.total ?? r.spend ?? r.balance ?? 0) },
        { key: "quantity", header: "Qty", align: "right", render: (r) => (r.quantity !== undefined ? String(r.quantity) : r.count !== undefined ? String(r.count) : "—") },
        { key: "due", header: "Outstanding", align: "right", render: (r) => money(r.due ?? r.balance ?? 0) },
      ]}
    />
  );
}
