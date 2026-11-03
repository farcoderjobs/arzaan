"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { money } from "@/lib/currency";
import { Button, Input, Select, FormField, Modal, Table, EmptyState } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";

interface PreviewRow {
  userId: string;
  userName: string;
  monthlySalary: number;
  hasSalary: boolean;
  calendarDays: number;
  scheduledDays: number;
  restDays: number;
  leaveDays: number;
  absentDays: number;
  allowanceDays: number;
  unpaidAbsenceDays: number;
  dailyRate: number;
  deduction: number;
  /** Employee purchases recovered from this salary (kept separate from absences). */
  purchaseDeduction?: number;
  netAfterPurchases?: number;
  netPayable: number;
}

interface PayrollEntryRow {
  _id: string;
  userId: string;
  userName: string;
  monthlySalary: number;
  calendarDays: number;
  scheduledDays: number;
  restDays: number;
  leaveDays: number;
  absentDays: number;
  allowanceDays: number;
  unpaidAbsenceDays: number;
  dailyRate: number;
  deduction: number;
  purchaseDeduction?: number;
  purchaseDeductions?: Array<{ _id: string; employeePurchaseId: string; amount: number; status: string }>;
  netPayable: number;
  paidAmount: number;
  status: "unpaid" | "partial" | "paid";
}

interface Totals {
  employees: number;
  grossSalary: number;
  deductions: number;
  netPayable: number;
  paidAmount: number;
  outstanding: number;
  absentDays: number;
}

interface PayrollPayload {
  period: string;
  policy: { weeklyRestDay: number; allowanceDays: number };
  branch: { _id: string; name: string };
  branches: Array<{ _id: string; name: string }>;
  canManage: boolean;
  payroll: { _id: string; status: "draft" | "finalized"; totals: Totals; generatedAt: string | null; finalizedAt: string | null } | null;
  entries: PayrollEntryRow[];
  preview: PreviewRow[];
  previewSummary: Totals;
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function PayrollClient({ canManage }: { canManage: boolean }) {
  const [period, setPeriod] = useState(currentPeriod());
  const [branchId, setBranchId] = useState("");
  const [data, setData] = useState<PayrollPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [salaryDraft, setSalaryDraft] = useState<Record<string, string>>({});
  const [payTarget, setPayTarget] = useState<PayrollEntryRow | null>(null);
  const [payAmount, setPayAmount] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ period });
      if (branchId) params.set("branchId", branchId);
      const res = await fetch(`/api/payroll?${params}`);
      const body = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(body, "Failed to load payroll"));
        return;
      }
      setData(body as PayrollPayload);
      if (!branchId && body.branch?._id) setBranchId(body.branch._id);
      const drafts: Record<string, string> = {};
      for (const row of body.preview ?? []) drafts[row.userId] = row.hasSalary ? String(row.monthlySalary) : "";
      setSalaryDraft(drafts);
    } catch {
      error("Error", "Failed to load payroll");
    } finally {
      setLoading(false);
    }
  }, [period, branchId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const action = async (payload: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      const res = await fetch("/api/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, branchId: branchId || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(body, "Payroll action failed"));
        return false;
      }
      success("Saved", typeof body?.message === "string" ? body.message : "Payroll updated");
      await load();
      return true;
    } catch {
      error("Error", "Payroll action failed");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveSalary = async (userId: string) => {
    const raw = salaryDraft[userId];
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      error("Error", "Enter a valid monthly salary");
      return;
    }
    await action({ action: "set-salary", userId, monthlySalary: value }, `salary:${userId}`);
  };

  const totals = data?.payroll?.totals ?? data?.previewSummary;
  const rows = data?.entries?.length ? data.entries : data?.preview ?? [];
  const isFinalized = data?.payroll?.status === "finalized";

  const summaryCards = useMemo(
    () => [
      { label: "Gross salary", value: totals?.grossSalary ?? 0 },
      { label: "Deductions", value: totals?.deductions ?? 0 },
      { label: "Net payable", value: totals?.netPayable ?? 0 },
      { label: "Paid", value: totals?.paidAmount ?? 0 },
      { label: "Outstanding", value: totals?.outstanding ?? 0 },
    ],
    [totals]
  );

  const entryColumns = [
    { key: "name", header: "Employee", render: (row: PreviewRow | PayrollEntryRow) => <span className="font-medium text-slate-900">{row.userName}</span> },
    { key: "salary", header: "Monthly", render: (row: PreviewRow | PayrollEntryRow) => money(row.monthlySalary) },
    { key: "days", header: "Days / Rate", render: (row: PreviewRow | PayrollEntryRow) => `${row.calendarDays}d · ${money(row.dailyRate)}` },
    { key: "absent", header: "Absent", render: (row: PreviewRow | PayrollEntryRow) => row.absentDays },
    { key: "allowance", header: "Allowance", render: (row: PreviewRow | PayrollEntryRow) => row.allowanceDays },
    { key: "unpaid", header: "Unpaid", render: (row: PreviewRow | PayrollEntryRow) => row.unpaidAbsenceDays },
    { key: "deduction", header: "Deduction", render: (row: PreviewRow | PayrollEntryRow) => money(row.deduction) },
    {
      key: "purchases",
      header: "Purchases",
      render: (row: PreviewRow | PayrollEntryRow) =>
        (row.purchaseDeduction ?? 0) > 0 ? (
          <span className="text-amber-700">{money(row.purchaseDeduction ?? 0)}</span>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      key: "net",
      header: "Net payable",
      render: (row: PreviewRow | PayrollEntryRow) => (
        <span className="font-semibold">
          {money("netAfterPurchases" in row && row.netAfterPurchases !== undefined ? row.netAfterPurchases : row.netPayable)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Paid",
      render: (row: PreviewRow | PayrollEntryRow) => {
        if (!("paidAmount" in row)) return <span className="text-xs text-slate-400">not generated</span>;
        return (
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", row.status === "paid" ? "bg-emerald-100 text-emerald-700" : row.status === "partial" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600")}>
            {money(row.paidAmount)} · {row.status}
          </span>
        );
      },
    },
    {
      key: "actions",
      header: "",
      className: "w-24",
      render: (row: PreviewRow | PayrollEntryRow) =>
        canManage && isFinalized && "paidAmount" in row && row.paidAmount < row.netPayable ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setPayTarget(row);
              setPayAmount(String(Math.max(0, row.netPayable - row.paidAmount)));
            }}
          >
            Pay
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Payroll" }]} />
      <PageHeader
        title="Payroll"
        description="Monthly salary, attendance deductions (7 non-penalty absence days) and payments."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canManage && data?.payroll?.status !== "finalized" ? (
              <Button loading={busy === "generate"} onClick={() => void action({ action: "generate", period }, "generate")}>
                {data?.payroll ? "Regenerate draft" : "Generate payroll"}
              </Button>
            ) : null}
            {canManage && data?.payroll?.status === "draft" && data?.entries.length ? (
              <Button variant="secondary" loading={busy === "finalize"} onClick={() => void action({ action: "finalize", period }, "finalize")}>
                Finalize
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => void load()} loading={loading}>
              Refresh
            </Button>
          </div>
        }
      />

      <div className="mb-6 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        <FormField label="Month">
          <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </FormField>
        <FormField label="Shop">
          <Select value={branchId} onChange={setBranchId} options={(data?.branches ?? []).map((b) => ({ value: b._id, label: b.name }))} />
        </FormField>
        <FormField label="State">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
            {data?.payroll ? (
              <span className={data.payroll.status === "finalized" ? "font-medium text-emerald-700" : "font-medium text-amber-700"}>
                {data.payroll.status}
              </span>
            ) : (
              <span className="text-slate-500">not generated</span>
            )}
          </div>
        </FormField>
        <FormField label="Policy">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
            {data?.policy.allowanceDays ?? 7} free absence days / month
          </div>
        </FormField>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {summaryCards.map((card) => (
          <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{card.label}</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{money(card.value)}</p>
          </div>
        ))}
      </div>

      <div className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Salary configuration</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wider text-slate-500">Employee</th>
                <th className="px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wider text-slate-500">Monthly salary</th>
                <th className="px-4 py-3 text-end text-[11px] font-semibold uppercase tracking-wider text-slate-500">Save</th>
              </tr>
            </thead>
            <tbody>
              {(data?.preview ?? []).map((row) => (
                <tr key={row.userId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5">{row.userName}</td>
                  <td className="px-4 py-2.5">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      className="max-w-[200px]"
                      value={salaryDraft[row.userId] ?? ""}
                      disabled={!canManage}
                      onChange={(e) => setSalaryDraft({ ...salaryDraft, [row.userId]: e.target.value })}
                      placeholder="Not configured"
                    />
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    {canManage ? (
                      <Button size="sm" variant="secondary" loading={busy === `salary:${row.userId}`} onClick={() => void saveSalary(row.userId)}>
                        Save
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h2 className="mb-2 text-sm font-semibold text-slate-700">
        {data?.entries.length ? `Payroll entries — ${data.period}` : "Preview (not generated yet)"}
      </h2>
      <Table
        columns={entryColumns}
        data={rows as Array<PreviewRow | PayrollEntryRow>}
        keyExtractor={(row) => ("_id" in row ? row._id : row.userId)}
        loading={loading}
        empty={<EmptyState label="No employees" description="Add employees with a salary to this shop." />}
      />

      <Modal
        open={payTarget !== null}
        onClose={() => setPayTarget(null)}
        title={`Record payment — ${payTarget?.userName ?? ""}`}
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
              const ok = await action({ action: "pay", period, userId: payTarget.userId, amount }, "pay");
              if (ok) setPayTarget(null);
            }}
          >
            Record payment
          </Button>,
        ]}
      >
        <p className="mb-3 text-sm text-slate-600">
          Outstanding: <strong>{money(Math.max(0, (payTarget?.netPayable ?? 0) - (payTarget?.paidAmount ?? 0)))}</strong>
        </p>
        <FormField label="Amount">
          <Input type="number" min="0" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
        </FormField>
      </Modal>
    </div>
  );
}
