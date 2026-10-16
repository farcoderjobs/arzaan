"use client";

import { ReportShell, money } from "@/components/report-shell";

interface Row {
  _id: string;
  name: string;
  phone: string;
  total?: number;
  paid?: number;
  balance?: number;
  orders?: number;
  payments?: number;
  lastPayment?: string | null;
}

const VIEWS = [
  { value: "purchases", label: "Purchases" },
  { value: "payments", label: "Payments" },
  { value: "balances", label: "Outstanding balances" },
];

export function SuppliersReportClient() {
  return (
    <ReportShell<Row>
      title="Suppliers Report"
      description="Purchases, payments and outstanding payables per supplier"
      endpoint="/api/reports/suppliers"
      viewParam="view"
      defaultView="purchases"
      views={VIEWS}
      summary={(data) => {
        const s = (data.summary ?? {}) as Record<string, number>;
        const view = String(data.view ?? "");
        if (view === "payments") return [{ label: "Total paid", value: money(s.paid ?? 0), tone: "blue" }];
        if (view === "balances") return [{ label: "Total payables", value: money(s.totalPayables ?? 0), tone: "red" }];
        return [
          { label: "Total purchases", value: money(s.total ?? 0), tone: "blue" },
          { label: "Outstanding", value: money(s.outstanding ?? 0), tone: "red" },
          { label: "Orders", value: String(s.orders ?? 0) },
        ];
      }}
      rows={(data) => ((data.rows as Row[]) ?? [])}
      rowKey={(r) => r._id}
      columns={[
        { key: "name", header: "Supplier", render: (r) => (
          <div>
            <p className="font-medium text-slate-900">{r.name}</p>
            {r.phone && <p className="text-xs text-slate-400">{r.phone}</p>}
          </div>
        ) },
        { key: "amount", header: "Amount", align: "right", render: (r) => {
          const value = r.total ?? r.paid ?? r.balance ?? 0;
          return <span className={r.balance !== undefined ? "font-semibold text-red-600" : "font-semibold"}>{money(value)}</span>;
        } },
        { key: "count", header: "Orders / Payments", align: "right", render: (r) => String(r.orders ?? r.payments ?? "—") },
        { key: "lastPayment", header: "Last payment", render: (r) => (r.lastPayment ? new Date(r.lastPayment).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—") },
      ]}
    />
  );
}
