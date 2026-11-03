"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { money } from "@/lib/currency";
import { Button, Input, Select, FormField, Modal, Table, EmptyState } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";

interface PurchaseRow {
  _id: string;
  purchaseNumber: string;
  invoiceNumber: string;
  employeeId: string;
  employeeName: string;
  departmentName: string;
  benefitMode: "percent" | "fixed";
  benefitPercent: number;
  grossAmount: number;
  benefitAmount: number;
  netAmount: number;
  paidAmount: number;
  outstandingAmount: number;
  status: "open" | "settled" | "deducted" | "canceled";
  payrollPeriod: string;
  payrollExcluded: boolean;
  createdAt: string;
}

interface EmployeeRow {
  employeeId: string;
  name: string;
  email: string;
  bonusPercent: number | null;
  outstanding: number;
  net: number;
  benefit: number;
  paid: number;
}

interface Payload {
  purchases: PurchaseRow[];
  summary: { outstanding: number; net: number; benefit: number; paid: number; count: number };
  byEmployee: EmployeeRow[];
  byDepartment: Array<{ department: string; net: number; benefit: number }>;
  total: number;
  page: number;
  totalPages: number;
  canPay: boolean;
  canExclude: boolean;
  canConfigure: boolean;
}

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "open", label: "Open (credit)" },
  { value: "settled", label: "Settled" },
  { value: "deducted", label: "Recovered by payroll" },
  { value: "canceled", label: "Canceled" },
];

export function EmployeePurchasesClient() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [payTarget, setPayTarget] = useState<PurchaseRow | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("cash");
  const [rateDraft, setRateDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), perPage: "25" });
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await fetch(`/api/employee-purchases?${params}`);
      const body = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(body, "Failed to load employee purchases"));
        return;
      }
      setData(body as Payload);
      const drafts: Record<string, string> = {};
      for (const row of body.byEmployee ?? []) {
        drafts[row.employeeId] = row.bonusPercent === null ? "" : String(row.bonusPercent);
      }
      setRateDraft(drafts);
    } catch {
      error("Error", "Failed to load employee purchases");
    } finally {
      setLoading(false);
    }
  }, [page, search, status, from, to]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const post = async (payload: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      const res = await fetch("/api/employee-purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(body, "Action failed"));
        return false;
      }
      success("Saved", typeof body?.message === "string" ? body.message : "Updated");
      await load();
      return true;
    } catch {
      error("Error", "Action failed");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = () => {
    const params = new URLSearchParams({ format: "csv", perPage: "100" });
    if (search) params.set("search", search);
    if (status) params.set("status", status);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    fetch(`/api/employee-purchases?${params}`)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error())))
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `employee-purchases-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => error("Export failed", "Could not download CSV"));
  };

  const cards = useMemo(() => {
    const s = data?.summary;
    return [
      { label: "Purchases", value: s?.count ?? 0, raw: true },
      { label: "Outstanding", value: s?.outstanding ?? 0 },
      { label: "Net purchased", value: s?.net ?? 0 },
      { label: "Employee benefit", value: s?.benefit ?? 0 },
      { label: "Paid by employees", value: s?.paid ?? 0 },
    ];
  }, [data]);

  const purchaseColumns = [
    {
      key: "purchase",
      header: "Purchase",
      render: (row: PurchaseRow) => (
        <div>
          <p className="font-mono text-xs text-slate-700">{row.purchaseNumber || row.invoiceNumber}</p>
          <p className="text-xs text-slate-400">{new Date(row.createdAt).toLocaleString()}</p>
        </div>
      ),
    },
    {
      key: "employee",
      header: "Employee",
      render: (row: PurchaseRow) => (
        <div>
          <p className="font-medium text-slate-900">{row.employeeName}</p>
          <p className="text-xs text-slate-400">{row.departmentName || "—"}</p>
        </div>
      ),
    },
    {
      key: "benefit",
      header: "Benefit",
      render: (row: PurchaseRow) => (
        <span className="text-xs text-slate-600">
          {row.benefitPercent ? `${row.benefitPercent}%` : row.benefitMode} · {money(row.benefitAmount)}
        </span>
      ),
    },
    { key: "gross", header: "Gross", render: (row: PurchaseRow) => money(row.grossAmount) },
    { key: "net", header: "Net", render: (row: PurchaseRow) => <span className="font-semibold">{money(row.netAmount)}</span> },
    { key: "paid", header: "Paid", render: (row: PurchaseRow) => money(row.paidAmount) },
    {
      key: "outstanding",
      header: "Outstanding",
      render: (row: PurchaseRow) => (
        <span className={row.outstandingAmount > 0 ? "font-semibold text-amber-700" : "text-slate-500"}>
          {money(row.outstandingAmount)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row: PurchaseRow) => (
        <div className="flex flex-col gap-1">
          <span
            className={cn(
              "w-fit rounded-full px-2 py-0.5 text-xs font-medium",
              row.status === "open"
                ? "bg-amber-100 text-amber-700"
                : row.status === "settled"
                  ? "bg-emerald-100 text-emerald-700"
                  : row.status === "canceled"
                    ? "bg-rose-100 text-rose-700"
                    : "bg-slate-100 text-slate-600"
            )}
          >
            {row.status}
          </span>
          {row.payrollPeriod && <span className="text-[11px] text-slate-400">payroll {row.payrollPeriod}</span>}
          {row.payrollExcluded && <span className="text-[11px] text-rose-500">excluded from payroll</span>}
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      className: "w-32",
      render: (row: PurchaseRow) => {
        if (row.status === "canceled" || row.status === "deducted") return null;
        return (
          <div className="flex items-center gap-1">
            {data?.canPay && row.outstandingAmount > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setPayTarget(row);
                  setPayAmount(String(row.outstandingAmount));
                  setPayMethod("cash");
                }}
              >
                Pay
              </Button>
            )}
            {data?.canExclude && (
              <Button
                size="sm"
                variant="ghost"
                loading={busy === `exclude:${row._id}`}
                onClick={() => void post({ action: "exclude", purchaseId: row._id, excluded: !row.payrollExcluded }, `exclude:${row._id}`)}
              >
                {row.payrollExcluded ? "Include" : "Exclude"}
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  const employeeColumns = [
    { key: "name", header: "Employee", render: (row: EmployeeRow) => <span className="font-medium text-slate-900">{row.name || row.email}</span> },
    {
      key: "rate",
      header: "Benefit rate",
      render: (row: EmployeeRow) => (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min="0"
            max="100"
            step="0.01"
            className="max-w-[110px]"
            value={rateDraft[row.employeeId] ?? ""}
            disabled={!data?.canConfigure}
            placeholder="default"
            onChange={(e) => setRateDraft({ ...rateDraft, [row.employeeId]: e.target.value })}
          />
          {data?.canConfigure && (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === `rate:${row.employeeId}`}
              onClick={() => {
                const raw = rateDraft[row.employeeId] ?? "";
                const percent = raw.trim() === "" ? null : Number(raw);
                if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
                  error("Error", "Enter a rate between 0 and 100");
                  return;
                }
                void post({ action: "set-rate", userId: row.employeeId, percent }, `rate:${row.employeeId}`);
              }}
            >
              Save
            </Button>
          )}
        </div>
      ),
    },
    { key: "net", header: "Purchased", render: (row: EmployeeRow) => money(row.net) },
    { key: "benefit", header: "Benefit", render: (row: EmployeeRow) => money(row.benefit) },
    { key: "paid", header: "Paid", render: (row: EmployeeRow) => money(row.paid) },
    { key: "outstanding", header: "Outstanding", render: (row: EmployeeRow) => <span className="font-semibold text-amber-700">{money(row.outstanding)}</span> },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Employee purchases" }]} />
      <PageHeader
        title="Employee purchases"
        description="Staff purchases with employee benefit, outstanding balances and payroll recovery."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" loading={loading} onClick={() => void load()}>
              Refresh
            </Button>
            <Button variant="secondary" onClick={exportCsv}>Export CSV</Button>
          </div>
        }
      />

      <div className="mb-6 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        <FormField label="Search">
          <Input value={search} placeholder="Employee, invoice…" onChange={(e) => setSearch(e.target.value)} />
        </FormField>
        <FormField label="Status">
          <Select value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        </FormField>
        <FormField label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{card.label}</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">
              {"raw" in card && card.raw ? card.value : money(card.value)}
            </p>
          </div>
        ))}
      </div>

      <h2 className="mb-2 text-sm font-semibold text-slate-700">Employee balances</h2>
      <div className="mb-6">
        <Table
          columns={employeeColumns}
          data={data?.byEmployee ?? []}
          keyExtractor={(row) => row.employeeId}
          loading={loading}
          empty={<EmptyState label="No employee purchases" description="Employee purchases recorded at the POS appear here." />}
        />
      </div>

      <h2 className="mb-2 text-sm font-semibold text-slate-700">Purchase history</h2>
      <Table
        columns={purchaseColumns}
        data={data?.purchases ?? []}
        keyExtractor={(row) => row._id}
        loading={loading}
        empty={<EmptyState label="No purchases" description="Employee purchases are recorded at the POS." />}
      />

      {(data?.totalPages ?? 0) > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Previous
          </Button>
          <span className="text-slate-500">
            Page {data?.page} of {data?.totalPages}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={page >= (data?.totalPages ?? 1)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      <Modal
        open={payTarget !== null}
        onClose={() => setPayTarget(null)}
        title={`Record payment — ${payTarget?.employeeName ?? ""}`}
        size="sm"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setPayTarget(null)}>
            Cancel
          </Button>,
          <Button
            key="pay"
            loading={busy === "pay"}
            onClick={async () => {
              if (!payTarget) return;
              const amount = Number(payAmount);
              if (!Number.isFinite(amount) || amount <= 0) {
                error("Error", "Enter a valid amount");
                return;
              }
              const idempotencyKey = `pay:${payTarget._id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
              const ok = await post(
                { action: "pay", purchaseId: payTarget._id, amount, method: payMethod, idempotencyKey },
                "pay"
              );
              if (ok) setPayTarget(null);
            }}
          >
            Record payment
          </Button>,
        ]}
      >
        <p className="mb-3 text-sm text-slate-600">
          Outstanding: <strong>{money(payTarget?.outstandingAmount ?? 0)}</strong>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Amount">
            <Input type="number" min="0" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
          </FormField>
          <FormField label="Method">
            <Select
              value={payMethod}
              onChange={setPayMethod}
              options={[
                { value: "cash", label: "Cash" },
                { value: "card", label: "Card" },
                { value: "transfer", label: "Transfer" },
              ]}
            />
          </FormField>
        </div>
      </Modal>
    </div>
  );
}
