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
  lastPurchase?: string | null;
  lastPayment?: string | null;
}

const VIEWS = [
  { value: "purchases", label: "Total purchases" },
  { value: "payments", label: "Payments" },
  { value: "balances", label: "Outstanding balances" },
];

export function CustomersReportClient() {
  return (
    <ReportShell<Row>
      title="Customers Report"
      description="Purchases, payments and outstanding balances per customer"
      endpoint="/api/reports/customers"
      viewParam="view"
      defaultView="purchases"
      views={VIEWS}
      summary={(data) => {
        const s = (data.summary ?? {}) as Record<string, number>;
        const view = String(data.view ?? "");
        if (view === "payments") return [{ label: "Total received", value: money(s.paid ?? 0), tone: "green" }];
        if (view === "balances") return [{ label: "Total receivables", value: money(s.totalReceivables ?? 0), tone: "red" }];
        return [
          { label: "Total purchases", value: money(s.total ?? 0), tone: "blue" },
          { label: "Orders", value: String(s.orders ?? 0) },
        ];
      }}
      rows={(data) => ((data.rows as Row[]) ?? [])}
      rowKey={(r) => r._id}
      columns={[
        { key: "name", header: "Customer", render: (r) => (
          <div>
            <p className="font-medium text-slate-900">{r.name}</p>
            {r.phone && <p className="text-xs text-slate-400">{r.phone}</p>}
          </div>
        ) },
        { key: "amount", header: "Amount", align: "right", render: (r) => {
          const value = r.total ?? r.paid ?? r.balance ?? 0;
          return <span className={r.balance !== undefined ? "font-semibold text-red-600" : "font-semibold"}>{money(value)}</span>;
        } },
        { key: "orders", header: "Orders / Payments", align: "right", render: (r) => String(r.orders ?? r.payments ?? "—") },
        { key: "last", header: "Last activity", render: (r) => {
          const d = r.lastPurchase ?? r.lastPayment;
          return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
        } },
      ]}
    />
  );
}
