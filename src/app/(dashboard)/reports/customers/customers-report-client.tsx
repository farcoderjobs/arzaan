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
  earned?: number;
  redeemed?: number;
  reversed?: number;
  entries?: number;
}

interface CashierRow {
  cashierId: string;
  name: string;
  earned: number;
  redeemed: number;
  entries: number;
}

const VIEWS = [
  { value: "purchases", label: "Total purchases" },
  { value: "payments", label: "Payments" },
  { value: "balances", label: "Outstanding balances" },
  { value: "bonus", label: "Reward credit" },
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
        if (view === "bonus") {
          return [
            { label: "Bonus earned", value: money(s.earned ?? 0), tone: "green" },
            { label: "Bonus redeemed", value: money(s.redeemed ?? 0), tone: "blue" },
            { label: "Reversed on returns", value: money(s.reversed ?? 0), tone: "red" },
            { label: "Expired", value: money(s.expired ?? 0), tone: "amber" },
            { label: "Outstanding liability", value: money(s.liability ?? 0), tone: "purple" },
          ];
        }
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
          if (r.earned !== undefined) {
            return <span className="font-semibold text-green-700">{money(r.earned)}</span>;
          }
          const value = r.total ?? r.paid ?? r.balance ?? 0;
          return <span className={r.balance !== undefined ? "font-semibold text-red-600" : "font-semibold"}>{money(value)}</span>;
        } },
        { key: "orders", header: "Orders / Payments", align: "right", render: (r) => {
          if (r.earned !== undefined) {
            return `−${money(r.redeemed ?? 0)} / bal ${money(r.balance ?? 0)}`;
          }
          return String(r.orders ?? r.payments ?? "—");
        } },
        { key: "last", header: "Last activity", render: (r) => {
          const d = r.lastPurchase ?? r.lastPayment;
          return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
        } },
      ]}
      chart={(data) => {
        if (String(data.view ?? "") !== "bonus") return null;
        const by = (data.byCashier ?? []) as CashierRow[];
        if (by.length === 0) return null;
        const max = Math.max(...by.map((c) => c.earned), 1);
        return (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Bonus by cashier</p>
            {by.map((c) => (
              <div key={c.cashierId || c.name} className="text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-slate-700">{c.name}</span>
                  <span className="text-slate-500">
                    earned {money(c.earned)} · redeemed {money(c.redeemed)}
                  </span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-slate-100">
                  <div
                    className="h-2 rounded-full bg-green-500"
                    style={{ width: `${Math.max(2, Math.round((c.earned / max) * 100))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        );
      }}
    />
  );
}
