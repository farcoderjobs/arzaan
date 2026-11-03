"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Table, EmptyState, Button, Modal, FormField, Input, Select, Checkbox } from "@/components/ui";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { success, error } from "@/utils/toast";
import { cn } from "@/utils/classname";
import { money } from "@/lib/currency";

interface CustomerDetailClientProps {
  customerId: string;
  canPayment: boolean;
  canViewSales: boolean;
  canEdit: boolean;
  canAdjustBonus?: boolean;
}

interface CustomerData {
  _id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  status: string;
  wholesaleEligible?: boolean;
  bonusPercent?: number;
  bonusBalance?: number;
  createdAt: string;
}

interface BonusEntry {
  _id: string;
  type: "EARN" | "REDEEM" | "REVERSAL" | "ADJUSTMENT";
  amount: number;
  balanceAfter: number;
  description: string;
  createdAt: string;
  userId: { _id: string; name: string } | null;
}

interface LedgerEntry {
  _id: string;
  type: "SALE" | "PAYMENT" | "REFUND" | "ADJUSTMENT";
  amount: number;
  balanceAfter: number;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  userId: { _id: string; name: string } | null;
  createdAt: string;
}

interface SaleRow {
  _id: string;
  invoiceNumber: string;
  createdAt: string;
  total: number;
  paidAmount: number;
  paymentMethod: string | null;
  status: string;
}

const TYPE_LABELS: Record<string, { label: string; className: string }> = {
  SALE: { label: "Credit Sale", className: "bg-red-100 text-red-700" },
  PAYMENT: { label: "Payment", className: "bg-green-100 text-green-700" },
  REFUND: { label: "Refund", className: "bg-blue-100 text-blue-700" },
  ADJUSTMENT: { label: "Adjustment", className: "bg-amber-100 text-amber-700" },
};

export function CustomerDetailClient({ customerId, canPayment, canViewSales, canEdit, canAdjustBonus }: CustomerDetailClientProps) {
  const [loading, setLoading] = useState(true);
  const [customer, setCustomer] = useState<CustomerData | null>(null);
  const [balance, setBalance] = useState(0);
  const [bonusBalance, setBonusBalance] = useState(0);
  const [bonusLedger, setBonusLedger] = useState<BonusEntry[]>([]);
  const [bonusSummary, setBonusSummary] = useState({ earned: 0, redeemed: 0, reversed: 0, adjusted: 0 });
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [recentSales, setRecentSales] = useState<SaleRow[]>([]);
  const [lifetime, setLifetime] = useState({ total: 0, count: 0 });

  const [payOpen, setPayOpen] = useState(false);
  const [payForm, setPayForm] = useState({ amount: "", method: "cash", reference: "", note: "", allowOverpay: false });
  const [paying, setPaying] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ bonusPercent: "0", wholesaleEligible: false });
  const [editSaving, setEditSaving] = useState(false);

  // Manual reward-credit adjustment (permission `bonus.adjust`, reason required).
  const [bonusAdjustOpen, setBonusAdjustOpen] = useState(false);
  const [bonusAdjust, setBonusAdjust] = useState({ amount: "", reason: "" });
  const [bonusAdjusting, setBonusAdjusting] = useState(false);

  const load = useCallback(async () => {

    try {
      const res = await fetch(`/api/customers/${customerId}?ledgerPage=${ledgerPage}`);
      if (!res.ok) throw new Error("Failed to load customer");
      const data = await res.json();
      setCustomer(data.customer);
      setBalance(data.balance ?? 0);
      setBonusBalance(data.bonusBalance ?? 0);
      setBonusLedger(data.bonusLedger?.entries ?? []);
      setBonusSummary(data.bonusLedger?.summary ?? { earned: 0, redeemed: 0, reversed: 0, adjusted: 0 });
      setLedger(data.ledger?.entries ?? []);
      setLedgerTotal(data.ledger?.total ?? 0);
      setRecentSales(data.recentSales ?? []);
      setLifetime(data.lifetimeSales ?? { total: 0, count: 0 });
    } catch {
      error("Error", "Failed to load customer");
    } finally {
      setLoading(false);
    }
  }, [customerId, ledgerPage]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const submitPayment = async () => {
    const amount = Number(payForm.amount);
    if (!payForm.amount || isNaN(amount) || amount <= 0) {
      error("Error", "Enter a valid amount");
      return;
    }
    setPaying(true);
    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "payment",
          customerId,
          amount,
          method: payForm.method,
          reference: payForm.reference.trim(),
          note: payForm.note.trim(),
          allowOverpay: payForm.allowOverpay,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to record payment");
        return;
      }
      success("Payment recorded", `New balance: ${money((data.data?.balanceAfter ?? 0))}`);
      setPayOpen(false);
      setPayForm({ amount: "", method: "cash", reference: "", note: "", allowOverpay: false });
      load();
    } catch {
      error("Error", "Failed to record payment");
    } finally {
      setPaying(false);
    }
  };

  const submitBonusAdjust = async () => {
    const amount = Number(bonusAdjust.amount);
    if (!bonusAdjust.amount || !Number.isFinite(amount) || amount === 0) {
      error("Error", "Enter a non-zero amount (use a minus sign to remove credit)");
      return;
    }
    if (bonusAdjust.reason.trim().length < 3) {
      error("Error", "A reason is required for every adjustment");
      return;
    }
    setBonusAdjusting(true);
    try {
      const res = await fetch(`/api/customers/${customerId}/bonus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          reason: bonusAdjust.reason.trim(),
          idempotencyKey: `${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to adjust reward credit");
        return;
      }
      success("Reward credit adjusted", `New balance: ${money(data.data?.balanceAfter ?? 0)}`);
      setBonusAdjustOpen(false);
      setBonusAdjust({ amount: "", reason: "" });
      load();
    } catch {
      error("Error", "Failed to adjust reward credit");
    } finally {
      setBonusAdjusting(false);
    }
  };

  const openEdit = () => {
    if (!customer) return;
    setEditForm({
      bonusPercent: String(customer.bonusPercent ?? 0),
      wholesaleEligible: customer.wholesaleEligible === true,
    });
    setEditOpen(true);
  };

  const saveSettings = async () => {
    if (!customer) return;
    const percent = Number(editForm.bonusPercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      error("Error", "Bonus percentage must be between 0 and 100");
      return;
    }
    setEditSaving(true);
    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: customer._id,
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          address: customer.address,
          notes: customer.notes,
          status: customer.status,
          bonusPercent: percent,
          wholesaleEligible: editForm.wholesaleEligible,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to update customer");
        return;
      }
      success("Customer updated", "Reward and wholesale settings saved");
      setEditOpen(false);
      load();
    } catch {
      error("Error", "Failed to update customer");
    } finally {
      setEditSaving(false);
    }
  };

  if (loading && !customer) {
    return <div className="mx-auto max-w-6xl"><div className="h-40 animate-pulse rounded-xl bg-slate-100" /></div>;
  }

  if (!customer) {
    return (
      <div className="mx-auto max-w-6xl">
        <EmptyState label="Customer not found" description="The customer may have been deleted." />
      </div>
    );
  }

  const ledgerTotalPages = Math.max(1, Math.ceil(ledgerTotal / 20));

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Customers", href: "/customers" }, { label: customer.name }]} />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{customer.name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {[customer.phone, customer.email].filter(Boolean).join(" · ") || "No contact info"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button variant="secondary" onClick={openEdit}>Reward & pricing settings</Button>
          )}
          {canPayment && customer.status === "active" && (
            <Button onClick={() => { setPayForm({ amount: balance > 0 ? balance.toFixed(2) : "", method: "cash", reference: "", note: "", allowOverpay: false }); setPayOpen(true); }}>
              Record Payment
            </Button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className={cn("rounded-xl border p-5", balance > 0 ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white")}>
          <p className="text-sm font-medium text-slate-500">Outstanding Balance</p>
          <p className={cn("mt-1 text-2xl font-semibold", balance > 0 ? "text-amber-700" : "text-slate-900")}>
            {money(balance)}
          </p>
          <p className="mt-1 text-xs text-slate-400">Calculated from transactions</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm font-medium text-slate-500">Lifetime Purchases</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{money(lifetime.total)}</p>
          <p className="mt-1 text-xs text-slate-400">{lifetime.count} completed sale{lifetime.count !== 1 ? "s" : ""}</p>
        </div>
        <div className={cn("rounded-xl border p-5", bonusBalance > 0 ? "border-green-200 bg-green-50" : "border-slate-200 bg-white")}>
          <p className="text-sm font-medium text-slate-500">Reward Credit</p>
          <p className={cn("mt-1 text-2xl font-semibold", bonusBalance > 0 ? "text-green-700" : "text-slate-900")}>
            {money(bonusBalance)}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Earns {customer.bonusPercent ?? 0}% · separate from cash and debt
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm font-medium text-slate-500">Status</p>
          <p className="mt-1 text-2xl font-semibold capitalize text-slate-900">{customer.status}</p>
          <p className="mt-1 text-xs text-slate-400">
            {customer.wholesaleEligible ? "Wholesale eligible" : "Retail pricing only"}
          </p>
        </div>
      </div>

      {customer.address || customer.notes ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {customer.address && (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Address</p>
              <p className="mt-1 text-sm text-slate-700">{customer.address}</p>
            </div>
          )}
          {customer.notes && (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Notes</p>
              <p className="mt-1 text-sm text-slate-700">{customer.notes}</p>
            </div>
          )}
        </div>
      ) : null}

      {/* Bonus ledger */}
      <div className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Reward Credit Ledger</h2>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-slate-500">
              Earned {money(bonusSummary.earned)} · Redeemed {money(bonusSummary.redeemed)} · Reversed {money(bonusSummary.reversed)}
            </p>
            {canAdjustBonus && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setBonusAdjust({ amount: "", reason: "" });
                  setBonusAdjustOpen(true);
                }}
              >
                Adjust reward credit
              </Button>
            )}
          </div>
        </div>
        <Table
          columns={[
            {
              key: "createdAt",
              header: "Date",
              render: (row: BonusEntry) => new Date(row.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }),
            },
            {
              key: "type",
              header: "Type",
              render: (row: BonusEntry) => {
                const styles: Record<string, string> = {
                  EARN: "bg-green-100 text-green-700",
                  REDEEM: "bg-blue-100 text-blue-700",
                  REVERSAL: "bg-red-100 text-red-700",
                  ADJUSTMENT: "bg-amber-100 text-amber-700",
                };
                return <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", styles[row.type])}>{row.type}</span>;
              },
            },
            {
              key: "description",
              header: "Description",
              render: (row: BonusEntry) => row.description,
            },
            {
              key: "amount",
              header: "Bonus",
              className: "text-right",
              render: (row: BonusEntry) => (
                <span className={cn("font-medium", row.amount > 0 ? "text-green-600" : "text-red-600")}>
                  {row.amount > 0 ? "+" : ""}{money(row.amount)}
                </span>
              ),
            },
            {
              key: "balanceAfter",
              header: "Balance",
              className: "text-right",
              render: (row: BonusEntry) => <span className="font-medium">{money(row.balanceAfter)}</span>,
            },
            { key: "user", header: "By", render: (row: BonusEntry) => row.userId?.name ?? "—" },
          ]}
          data={bonusLedger}
          keyExtractor={(row) => row._id}
          loading={loading}
          empty={<EmptyState label="No reward activity" description="Bonus is earned on completed sales for customers with a bonus percentage." />}
        />
      </div>

      {/* Ledger */}
      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Customer Ledger</h2>
        <Table
          columns={[
            {
              key: "createdAt",
              header: "Date",
              render: (row: LedgerEntry) => new Date(row.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }),
            },
            {
              key: "type",
              header: "Type",
              render: (row: LedgerEntry) => {
                const meta = TYPE_LABELS[row.type] ?? { label: row.type, className: "bg-slate-100 text-slate-600" };
                return <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", meta.className)}>{meta.label}</span>;
              },
            },
            {
              key: "description",
              header: "Description",
              render: (row: LedgerEntry) => (
                <span>
                  {row.description}
                  {row.referenceType === "sale" && row.referenceId && canViewSales ? (
                    <Link href={`/sales/${row.referenceId}`} className="ml-2 text-xs text-blue-600 hover:underline">
                      View sale
                    </Link>
                  ) : null}
                </span>
              ),
            },
            {
              key: "amount",
              header: "Amount",
              className: "text-right",
              render: (row: LedgerEntry) => (
                <span className={cn("font-medium", row.amount > 0 ? "text-red-600" : "text-green-600")}>
                  {row.amount > 0 ? "+" : ""}{money(row.amount)}
                </span>
              ),
            },
            {
              key: "balanceAfter",
              header: "Balance",
              className: "text-right",
              render: (row: LedgerEntry) => <span className="font-medium">{money(row.balanceAfter)}</span>,
            },
            {
              key: "user",
              header: "By",
              render: (row: LedgerEntry) => row.userId?.name ?? "—",
            },
          ]}
          data={ledger}
          keyExtractor={(row) => row._id}
          loading={loading}
          empty={<EmptyState label="No transactions" description="Ledger entries appear when the customer buys on credit, pays or is refunded." />}
        />
        {ledgerTotalPages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-2 text-sm">
            <Button variant="secondary" size="sm" disabled={ledgerPage <= 1} onClick={() => setLedgerPage((p) => Math.max(1, p - 1))}>Previous</Button>
            <span className="text-slate-500">Page {ledgerPage} of {ledgerTotalPages}</span>
            <Button variant="secondary" size="sm" disabled={ledgerPage >= ledgerTotalPages} onClick={() => setLedgerPage((p) => p + 1)}>Next</Button>
          </div>
        )}
      </div>

      {/* Purchase history */}
      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Purchase History</h2>
        <Table
          columns={[
            {
              key: "invoiceNumber",
              header: "Invoice",
              render: (row: SaleRow) =>
                canViewSales ? (
                  <Link href={`/sales/${row._id}`} className="font-mono text-sm text-blue-600 hover:underline">{row.invoiceNumber}</Link>
                ) : (
                  <span className="font-mono text-sm">{row.invoiceNumber}</span>
                ),
            },
            {
              key: "createdAt",
              header: "Date",
              render: (row: SaleRow) => new Date(row.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
            },
            {
              key: "paymentMethod",
              header: "Payment",
              render: (row: SaleRow) => <span className="capitalize">{row.paymentMethod ?? "—"}</span>,
            },
            {
              key: "total",
              header: "Total",
              className: "text-right",
              render: (row: SaleRow) => <span className="font-medium">{money(row.total)}</span>,
            },
          ]}
          data={recentSales}
          keyExtractor={(row) => row._id}
          loading={loading}
          empty={<EmptyState label="No purchases yet" description="Completed sales for this customer will appear here." />}
        />
      </div>

      {/* Reward & wholesale settings */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Reward & pricing settings"
        description="Only administrators with customer update permission can change these values."
        size="sm"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setEditOpen(false)}>Cancel</Button>,
          <Button key="save" loading={editSaving} onClick={saveSettings}>Save</Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Bonus percentage" hint="Percentage of eligible merchandise earned as reward credit, e.g. 1 for 1%">
            <Input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={editForm.bonusPercent}
              onChange={(e) => setEditForm({ ...editForm, bonusPercent: e.target.value })}
            />
          </FormField>
          <Checkbox
            label="Wholesale pricing eligible"
            checked={editForm.wholesaleEligible}
            onChange={(e) => setEditForm({ ...editForm, wholesaleEligible: e.target.checked })}
          />
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Reward credit is stored separately from cash, revenue and customer debt. Returns reverse earned credit proportionally.
          </p>
        </div>
      </Modal>

      {/* Reward-credit adjustment (manual, reason mandatory, audited) */}
      <Modal
        open={bonusAdjustOpen}
        onClose={() => setBonusAdjustOpen(false)}
        title="Adjust reward credit"
        description={`Current balance: ${money(bonusBalance)}`}
        size="sm"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setBonusAdjustOpen(false)}>Cancel</Button>,
          <Button key="save" loading={bonusAdjusting} onClick={submitBonusAdjust}>Apply adjustment</Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Amount" required hint="Positive adds credit, negative removes it">
            <Input
              type="number"
              step="0.01"
              value={bonusAdjust.amount}
              onChange={(e) => setBonusAdjust({ ...bonusAdjust, amount: e.target.value })}
              placeholder="0.00"
            />
          </FormField>
          <FormField label="Reason" required>
            <Input
              value={bonusAdjust.reason}
              onChange={(e) => setBonusAdjust({ ...bonusAdjust, reason: e.target.value })}
              placeholder="Why is this balance changing?"
            />
          </FormField>
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Adjustments are append-only ledger entries: history is never edited, and the audit log keeps your name.
          </p>
        </div>
      </Modal>

      {/* Payment modal */}
      <Modal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        title="Record Payment"
        description={`Outstanding balance: ${money(balance)}`}
        size="sm"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setPayOpen(false)}>Cancel</Button>,
          <Button key="pay" loading={paying} onClick={submitPayment}>Record Payment</Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Amount" required>
            <Input type="number" min="0.01" step="0.01" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} placeholder="0.00" />
          </FormField>
          <FormField label="Method">
            <Select
              value={payForm.method}
              onChange={(v) => setPayForm({ ...payForm, method: v })}
              options={[
                { value: "cash", label: "Cash" },
                { value: "card", label: "Card" },
                { value: "transfer", label: "Bank Transfer" },
                { value: "check", label: "Check" },
                { value: "other", label: "Other" },
              ]}
            />
          </FormField>
          <FormField label="Reference">
            <Input value={payForm.reference} onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} placeholder="Transaction ref (optional)" />
          </FormField>
          <FormField label="Note">
            <Input value={payForm.note} onChange={(e) => setPayForm({ ...payForm, note: e.target.value })} placeholder="Note (optional)" />
          </FormField>
          {Number(payForm.amount || 0) > balance + 0.001 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
              More than the outstanding balance — the extra becomes an advance on the customer&apos;s account.
            </p>
          )}
          <Checkbox
            label="Allow overpayment (record as advance / deposit)"
            checked={payForm.allowOverpay}
            onChange={(e) => setPayForm({ ...payForm, allowOverpay: e.target.checked })}
          />
        </div>
      </Modal>
    </div>
  );
}
