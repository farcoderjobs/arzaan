"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Modal, FormField, Input, Select, Textarea, Table, EmptyState, Pagination, ConfirmDialog } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { success, error } from "@/utils/toast";
import { cn } from "@/utils/classname";
import { Plus, Edit, Trash } from "@/components/ui/icons";

export interface FinanceClientProps {
  canViewExpenses: boolean;
  canCreateExpense: boolean;
  canUpdateExpense: boolean;
  canDeleteExpense: boolean;
  canViewCustomerPayments: boolean;
  canCreateCustomerPayment: boolean;
  canViewSupplierPayments: boolean;
  canCreateSupplierPayment: boolean;
  canViewCashTransactions: boolean;
}

import { money } from "@/lib/currency";

const EXPENSE_CATEGORIES = [
  { value: "rent", label: "Rent" },
  { value: "electricity", label: "Electricity" },
  { value: "internet", label: "Internet" },
  { value: "salary", label: "Salary" },
  { value: "transport", label: "Transport" },
  { value: "maintenance", label: "Maintenance" },
  { value: "packaging", label: "Packaging" },
  { value: "other", label: "Other" },
];

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "transfer", label: "Bank Transfer" },
  { value: "check", label: "Check" },
  { value: "other", label: "Other" },
];

const STATUS_STYLES: Record<string, string> = {
  completed: "bg-green-100 text-green-700",
  pending: "bg-amber-100 text-amber-700",
  draft: "bg-slate-100 text-slate-600",
  canceled: "bg-red-100 text-red-700 line-through",
};

const TX_STYLES: Record<string, string> = {
  opening: "bg-blue-100 text-blue-700",
  sale: "bg-green-100 text-green-700",
  refund: "bg-orange-100 text-orange-700",
  expense: "bg-red-100 text-red-700",
  income: "bg-emerald-100 text-emerald-700",
  adjustment: "bg-purple-100 text-purple-700",
  closing: "bg-slate-100 text-slate-600",
};

type Tab = "expenses" | "customer-payments" | "supplier-payments" | "cash-transactions";

function downloadCsv(url: string, filename: string) {
  fetch(url)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("export failed"))))
    .then((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch(() => error("Export failed", "Could not download CSV"));
}

export function FinanceClient(props: FinanceClientProps) {
  const availableTabs: Array<{ key: Tab; label: string }> = [];
  if (props.canViewExpenses) availableTabs.push({ key: "expenses", label: "Expenses" });
  if (props.canViewCustomerPayments) availableTabs.push({ key: "customer-payments", label: "Customer Payments" });
  if (props.canViewSupplierPayments) availableTabs.push({ key: "supplier-payments", label: "Supplier Payments" });
  if (props.canViewCashTransactions) availableTabs.push({ key: "cash-transactions", label: "Cash Transactions" });

  const [tab, setTab] = useState<Tab>(availableTabs[0]?.key ?? "expenses");

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Finance" }]} />
      <PageHeader title="Finance" description="Expenses, payments and cash movements" />

      <div className="mb-6 flex gap-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1">
        {availableTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition",
              tab === t.key ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "expenses" && props.canViewExpenses && (
        <ExpensesSection canCreate={props.canCreateExpense} canUpdate={props.canUpdateExpense} canDelete={props.canDeleteExpense} />
      )}
      {tab === "customer-payments" && props.canViewCustomerPayments && (
        <CustomerPaymentsSection canCreate={props.canCreateCustomerPayment} />
      )}
      {tab === "supplier-payments" && props.canViewSupplierPayments && (
        <SupplierPaymentsSection canCreate={props.canCreateSupplierPayment} />
      )}
      {tab === "cash-transactions" && props.canViewCashTransactions && <CashTransactionsSection />}
    </div>
  );
}

/* ---------------------------------- Expenses ---------------------------------- */

interface ExpenseRow {
  _id: string;
  category: string;
  description: string;
  amount: number;
  paymentMethod: string;
  reference: string;
  status: string;
  date: string;
  userName: string;
}

function ExpensesSection({ canCreate, canUpdate, canDelete }: { canCreate: boolean; canUpdate: boolean; canDelete: boolean }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [summary, setSummary] = useState({ totalAmount: 0, count: 0 });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const perPage = 15;

  const [filters, setFilters] = useState({ category: "", status: "", from: "", to: "", search: "" });

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const [form, setForm] = useState({ category: "other", amount: "", paymentMethod: "cash", description: "", reference: "", date: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ExpenseRow | null>(null);

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (filters.category) params.set("category", filters.category);
      if (filters.status) params.set("status", filters.status);
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.search) params.set("search", filters.search);
      const res = await fetch(`/api/finance/expenses?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRows(data.expenses ?? []);
      setTotal(data.total ?? 0);
      setSummary(data.summary ?? { totalAmount: 0, count: 0 });
    } catch {
      error("Error", "Failed to load expenses");
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm({ category: "other", amount: "", paymentMethod: "cash", description: "", reference: "", date: new Date().toISOString().slice(0, 10), note: "" });
    setModalOpen(true);
  };

  const openEdit = (row: ExpenseRow) => {
    setEditing(row);
    setForm({
      category: row.category,
      amount: String(row.amount),
      paymentMethod: row.paymentMethod,
      description: row.description,
      reference: row.reference ?? "",
      date: new Date(row.date).toISOString().slice(0, 10),
      note: "",
    });
    setModalOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        category: form.category,
        amount: Number(form.amount) || 0,
        paymentMethod: form.paymentMethod,
        description: form.description,
        reference: form.reference,
        note: form.note,
        date: form.date || undefined,
      };
      if (editing) payload.id = editing._id;
      const res = await fetch("/api/finance/expenses", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Failed", data?.error?.message ?? "Could not save expense");
        return;
      }
      success(editing ? "Expense updated" : "Expense recorded");
      setModalOpen(false);
      load();
    } catch {
      error("Error", "Could not save expense");
    } finally {
      setSaving(false);
    }
  };

  const cancelExpense = async () => {
    if (!cancelTarget) return;
    try {
      const res = await fetch("/api/finance/expenses", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cancelTarget._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Failed", data?.error?.message ?? "Could not cancel expense");
        return;
      }
      success("Expense canceled", "The record is kept for audit");
      setCancelTarget(null);
      load();
    } catch {
      error("Error", "Could not cancel expense");
    }
  };

  const columns = [
    { key: "date", header: "Date", render: (r: ExpenseRow) => new Date(r.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) },
    { key: "category", header: "Category", render: (r: ExpenseRow) => <span className="capitalize">{r.category}</span> },
    { key: "description", header: "Description", render: (r: ExpenseRow) => <span className="block max-w-[260px] truncate">{r.description}</span> },
    { key: "amount", header: "Amount", className: "text-right", render: (r: ExpenseRow) => <span className="font-semibold">{money(r.amount)}</span> },
    { key: "paymentMethod", header: "Method", render: (r: ExpenseRow) => <span className="capitalize">{r.paymentMethod}</span> },
    { key: "reference", header: "Reference", render: (r: ExpenseRow) => r.reference || "—" },
    {
      key: "status",
      header: "Status",
      render: (r: ExpenseRow) => (
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", STATUS_STYLES[r.status] ?? "bg-slate-100")}>{r.status}</span>
      ),
    },
    {
      key: "actions",
      header: "",
      className: "w-24",
      render: (r: ExpenseRow) => (
        <div className="flex justify-end gap-1">
          {canUpdate && r.status !== "canceled" && (
            <button onClick={() => openEdit(r)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="Edit">
              <Edit className="h-4 w-4" />
            </button>
          )}
          {canDelete && r.status !== "canceled" && (
            <button onClick={() => setCancelTarget(r)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Cancel expense">
              <Trash className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="grid flex-1 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <Input placeholder="Search description…" value={filters.search} onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }} />
          <Select value={filters.category} onChange={(v) => { setFilters({ ...filters, category: v }); setPage(1); }} placeholder="All categories" options={EXPENSE_CATEGORIES} />
          <Select
            value={filters.status}
            onChange={(v) => { setFilters({ ...filters, status: v }); setPage(1); }}
            placeholder="All statuses"
            options={[
              { value: "completed", label: "Completed" },
              { value: "pending", label: "Pending" },
              { value: "canceled", label: "Canceled" },
            ]}
          />
          <Input type="date" value={filters.from} onChange={(e) => { setFilters({ ...filters, from: e.target.value }); setPage(1); }} />
          <Input type="date" value={filters.to} onChange={(e) => { setFilters({ ...filters, to: e.target.value }); setPage(1); }} />
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => downloadCsv(`/api/finance/expenses?format=csv&category=${filters.category}&status=${filters.status}&from=${filters.from}&to=${filters.to}`, "expenses.csv")}>
            Export CSV
          </Button>
          {canCreate && (
            <Button onClick={openCreate}>
              <Plus className="mr-1.5 h-4 w-4" /> New Expense
            </Button>
          )}
        </div>
      </div>

      <div className="mb-3 flex gap-6 text-sm text-slate-500">
        <span>
          Total: <strong className="text-slate-900">{money(summary.totalAmount)}</strong> ({summary.count} expenses)
        </span>
      </div>

      <Table
        columns={columns}
        data={rows}
        keyExtractor={(r) => r._id}
        loading={loading}
        empty={<EmptyState label="No expenses found" description="Record your first expense to see it here." />}
      />
      {Math.ceil(total / perPage) > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={Math.ceil(total / perPage)} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit Expense" : "New Expense"}
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setModalOpen(false)} disabled={saving}>Cancel</Button>,
          <Button key="save" loading={saving} onClick={save}>{editing ? "Save changes" : "Record expense"}</Button>,
        ]}
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Category" required>
              <Select value={form.category} onChange={(v) => setForm({ ...form, category: v })} options={EXPENSE_CATEGORIES} />
            </FormField>
            <FormField label="Amount" required>
              <Input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
            </FormField>
            <FormField label="Payment method" required>
              <Select value={form.paymentMethod} onChange={(v) => setForm({ ...form, paymentMethod: v })} options={PAYMENT_METHODS} />
            </FormField>
            <FormField label="Date" required>
              <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </FormField>
          </div>
          <FormField label="Description" required>
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What was this expense for?" />
          </FormField>
          <FormField label="Reference" hint="Receipt / invoice number">
            <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="e.g. RCV-0042" />
          </FormField>
          {form.paymentMethod === "cash" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Cash expenses are deducted from your open cash register immediately.
            </p>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        onConfirm={cancelExpense}
        title="Cancel expense"
        message={`Cancel "${cancelTarget?.description}"? The record stays in history for audit; cash expenses return the money to the drawer.`}
        confirmLabel="Cancel expense"
        variant="danger"
      />
    </div>
  );
}

/* ----------------------------- Customer payments ----------------------------- */

interface CustomerPaymentRow {
  _id: string;
  customerName: string;
  amount: number;
  method: string;
  reference: string;
  userName: string;
  createdAt: string;
}

function CustomerPaymentsSection({ canCreate }: { canCreate: boolean }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<CustomerPaymentRow[]>([]);
  const [summary, setSummary] = useState({ totalAmount: 0 });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const perPage = 15;
  const [filters, setFilters] = useState({ method: "", from: "", to: "", search: "" });

  const [modalOpen, setModalOpen] = useState(false);
  const [customers, setCustomers] = useState<Array<{ value: string; label: string }>>([]);
  const [form, setForm] = useState({ customerId: "", amount: "", method: "cash", reference: "", note: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (filters.method) params.set("method", filters.method);
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.search) params.set("search", filters.search);
      const res = await fetch(`/api/finance/customer-payments?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRows(data.payments ?? []);
      setTotal(data.total ?? 0);
      setSummary(data.summary ?? { totalAmount: 0 });
    } catch {
      error("Error", "Failed to load customer payments");
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const openModal = async () => {
    setForm({ customerId: "", amount: "", method: "cash", reference: "", note: "" });
    setModalOpen(true);
    try {
      const res = await fetch("/api/customers?perPage=100&status=active");
      if (res.ok) {
        const data = await res.json();
        setCustomers((data.customers ?? []).map((c: { _id: string; name: string }) => ({ value: c._id, label: c.name })));
      }
    } catch {
      // ignore
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/finance/customer-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, amount: Number(form.amount) || 0 }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Failed", data?.error?.message ?? "Could not record payment");
        return;
      }
      success("Payment recorded", `New balance: ${money(data.data.balanceAfter)}`);
      setModalOpen(false);
      load();
    } catch {
      error("Error", "Could not record payment");
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    { key: "createdAt", header: "Date", render: (r: CustomerPaymentRow) => new Date(r.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) },
    { key: "customerName", header: "Customer" },
    { key: "amount", header: "Amount", className: "text-right", render: (r: CustomerPaymentRow) => <span className="font-semibold text-green-700">+{money(r.amount)}</span> },
    { key: "method", header: "Method", render: (r: CustomerPaymentRow) => <span className="capitalize">{r.method}</span> },
    { key: "reference", header: "Reference", render: (r: CustomerPaymentRow) => r.reference || "—" },
    { key: "userName", header: "Recorded by" },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="grid flex-1 gap-3 md:grid-cols-4">
          <Input placeholder="Search…" value={filters.search} onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }} />
          <Select value={filters.method} onChange={(v) => { setFilters({ ...filters, method: v }); setPage(1); }} placeholder="All methods" options={PAYMENT_METHODS} />
          <Input type="date" value={filters.from} onChange={(e) => { setFilters({ ...filters, from: e.target.value }); setPage(1); }} />
          <Input type="date" value={filters.to} onChange={(e) => { setFilters({ ...filters, to: e.target.value }); setPage(1); }} />
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => downloadCsv(`/api/finance/customer-payments?format=csv&method=${filters.method}&from=${filters.from}&to=${filters.to}`, "customer-payments.csv")}>
            Export CSV
          </Button>
          {canCreate && (
            <Button onClick={openModal}>
              <Plus className="mr-1.5 h-4 w-4" /> Record Payment
            </Button>
          )}
        </div>
      </div>

      <div className="mb-3 text-sm text-slate-500">
        Total received: <strong className="text-slate-900">{money(summary.totalAmount)}</strong>
      </div>

      <Table
        columns={columns}
        data={rows}
        keyExtractor={(r) => r._id}
        loading={loading}
        empty={<EmptyState label="No customer payments" description="Payments against customer balances appear here." />}
      />
      {Math.ceil(total / perPage) > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={Math.ceil(total / perPage)} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Record Customer Payment"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setModalOpen(false)} disabled={saving}>Cancel</Button>,
          <Button key="save" loading={saving} onClick={save}>Record Payment</Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Customer" required>
            <Select value={form.customerId} onChange={(v) => setForm({ ...form, customerId: v })} placeholder="Select customer" options={customers} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Amount" required>
              <Input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
            </FormField>
            <FormField label="Method" required>
              <Select value={form.method} onChange={(v) => setForm({ ...form, method: v })} options={PAYMENT_METHODS} />
            </FormField>
          </div>
          <FormField label="Reference">
            <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="Receipt / bank reference" />
          </FormField>
          <FormField label="Note">
            <Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} rows={2} />
          </FormField>
          {form.method === "cash" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Cash payments are added to your open cash register immediately.
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}

/* ----------------------------- Supplier payments ----------------------------- */

interface SupplierPaymentRow {
  _id: string;
  supplierName: string;
  amount: number;
  method: string;
  reference: string;
  userName: string;
  createdAt: string;
}

function SupplierPaymentsSection({ canCreate }: { canCreate: boolean }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<SupplierPaymentRow[]>([]);
  const [summary, setSummary] = useState({ totalAmount: 0 });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const perPage = 15;
  const [filters, setFilters] = useState({ method: "", from: "", to: "", search: "" });

  const [modalOpen, setModalOpen] = useState(false);
  const [suppliers, setSuppliers] = useState<Array<{ value: string; label: string }>>([]);
  const [form, setForm] = useState({ supplierId: "", amount: "", method: "cash", reference: "", note: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (filters.method) params.set("method", filters.method);
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.search) params.set("search", filters.search);
      const res = await fetch(`/api/finance/supplier-payments?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRows(data.payments ?? []);
      setTotal(data.total ?? 0);
      setSummary(data.summary ?? { totalAmount: 0 });
    } catch {
      error("Error", "Failed to load supplier payments");
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const openModal = async () => {
    setForm({ supplierId: "", amount: "", method: "cash", reference: "", note: "" });
    setModalOpen(true);
    try {
      const res = await fetch("/api/suppliers");
      if (res.ok) {
        const data = await res.json();
        setSuppliers((Array.isArray(data) ? data : []).map((s: { _id: string; name: string }) => ({ value: s._id, label: s.name })));
      }
    } catch {
      // ignore
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/finance/supplier-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, amount: Number(form.amount) || 0 }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Failed", data?.error?.message ?? "Could not record payment");
        return;
      }
      success("Payment recorded", `New payable balance: ${money(data.data.balanceAfter)}`);
      setModalOpen(false);
      load();
    } catch {
      error("Error", "Could not record payment");
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    { key: "createdAt", header: "Date", render: (r: SupplierPaymentRow) => new Date(r.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) },
    { key: "supplierName", header: "Supplier" },
    { key: "amount", header: "Amount", className: "text-right", render: (r: SupplierPaymentRow) => <span className="font-semibold text-red-600">−{money(r.amount)}</span> },
    { key: "method", header: "Method", render: (r: SupplierPaymentRow) => <span className="capitalize">{r.method}</span> },
    { key: "reference", header: "Reference", render: (r: SupplierPaymentRow) => r.reference || "—" },
    { key: "userName", header: "Recorded by" },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="grid flex-1 gap-3 md:grid-cols-4">
          <Input placeholder="Search…" value={filters.search} onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }} />
          <Select value={filters.method} onChange={(v) => { setFilters({ ...filters, method: v }); setPage(1); }} placeholder="All methods" options={PAYMENT_METHODS} />
          <Input type="date" value={filters.from} onChange={(e) => { setFilters({ ...filters, from: e.target.value }); setPage(1); }} />
          <Input type="date" value={filters.to} onChange={(e) => { setFilters({ ...filters, to: e.target.value }); setPage(1); }} />
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => downloadCsv(`/api/finance/supplier-payments?format=csv&method=${filters.method}&from=${filters.from}&to=${filters.to}`, "supplier-payments.csv")}>
            Export CSV
          </Button>
          {canCreate && (
            <Button onClick={openModal}>
              <Plus className="mr-1.5 h-4 w-4" /> Pay Supplier
            </Button>
          )}
        </div>
      </div>

      <div className="mb-3 text-sm text-slate-500">
        Total paid: <strong className="text-slate-900">{money(summary.totalAmount)}</strong>
      </div>

      <Table
        columns={columns}
        data={rows}
        keyExtractor={(r) => r._id}
        loading={loading}
        empty={<EmptyState label="No supplier payments" description="Payments to suppliers appear here." />}
      />
      {Math.ceil(total / perPage) > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={Math.ceil(total / perPage)} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Pay Supplier"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setModalOpen(false)} disabled={saving}>Cancel</Button>,
          <Button key="save" loading={saving} onClick={save}>Record Payment</Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Supplier" required>
            <Select value={form.supplierId} onChange={(v) => setForm({ ...form, supplierId: v })} placeholder="Select supplier" options={suppliers} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Amount" required>
              <Input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
            </FormField>
            <FormField label="Method" required>
              <Select value={form.method} onChange={(v) => setForm({ ...form, method: v })} options={PAYMENT_METHODS} />
            </FormField>
          </div>
          <FormField label="Reference">
            <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="Check / bank reference" />
          </FormField>
          <FormField label="Note">
            <Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} rows={2} />
          </FormField>
          {form.method === "cash" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Cash payments are deducted from your open cash register immediately.
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}

/* ----------------------------- Cash transactions ----------------------------- */

interface CashTxRow {
  _id: string;
  type: string;
  amount: number;
  description: string;
  userName: string;
  createdAt: string;
}

function CashTransactionsSection() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<CashTxRow[]>([]);
  const [summary, setSummary] = useState({ inflow: 0, outflow: 0, net: 0 });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const perPage = 20;
  const [filters, setFilters] = useState({ type: "", from: "", to: "", search: "" });

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (filters.type) params.set("type", filters.type);
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.search) params.set("search", filters.search);
      const res = await fetch(`/api/finance/cash-transactions?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRows(data.transactions ?? []);
      setTotal(data.total ?? 0);
      setSummary(data.summary ?? { inflow: 0, outflow: 0, net: 0 });
    } catch {
      error("Error", "Failed to load cash transactions");
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const columns = [
    { key: "createdAt", header: "Date", render: (r: CashTxRow) => new Date(r.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) },
    {
      key: "type",
      header: "Type",
      render: (r: CashTxRow) => (
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", TX_STYLES[r.type] ?? "bg-slate-100 text-slate-600")}>{r.type}</span>
      ),
    },
    { key: "description", header: "Description", render: (r: CashTxRow) => <span className="block max-w-[280px] truncate">{r.description}</span> },
    {
      key: "amount",
      header: "Amount",
      className: "text-right",
      render: (r: CashTxRow) => (
        <span className={cn("font-semibold", r.amount < 0 ? "text-red-600" : "text-green-700")}>
          {r.amount < 0 ? "−" : "+"}
          {money(Math.abs(r.amount))}
        </span>
      ),
    },
    { key: "userName", header: "Recorded by" },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="grid flex-1 gap-3 md:grid-cols-4">
          <Input placeholder="Search description…" value={filters.search} onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }} />
          <Select
            value={filters.type}
            onChange={(v) => { setFilters({ ...filters, type: v }); setPage(1); }}
            placeholder="All types"
            options={["opening", "sale", "refund", "expense", "income", "adjustment", "closing"].map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))}
          />
          <Input type="date" value={filters.from} onChange={(e) => { setFilters({ ...filters, from: e.target.value }); setPage(1); }} />
          <Input type="date" value={filters.to} onChange={(e) => { setFilters({ ...filters, to: e.target.value }); setPage(1); }} />
        </div>
        <Button variant="secondary" onClick={() => downloadCsv(`/api/finance/cash-transactions?format=csv&type=${filters.type}&from=${filters.from}&to=${filters.to}`, "cash-transactions.csv")}>
          Export CSV
        </Button>
      </div>

      <div className="mb-3 flex gap-6 text-sm text-slate-500">
        <span>Inflow: <strong className="text-green-700">{money(summary.inflow)}</strong></span>
        <span>Outflow: <strong className="text-red-600">{money(summary.outflow)}</strong></span>
        <span>Net: <strong className="text-slate-900">{money(summary.net)}</strong></span>
      </div>

      <Table
        columns={columns}
        data={rows}
        keyExtractor={(r) => r._id}
        loading={loading}
        empty={<EmptyState label="No cash transactions" description="Drawer movements are recorded here automatically." />}
      />
      {Math.ceil(total / perPage) > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={Math.ceil(total / perPage)} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
