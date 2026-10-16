"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Table, EmptyState, Button, Modal, SearchInput, FormField, Input, Select, Textarea, Checkbox } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Pagination } from "@/components/ui/pagination";
import { success, error } from "@/utils/toast";
import { cn } from "@/utils/classname";
import { money } from "@/lib/currency";
import { Plus, Edit, Trash } from "@/components/ui/icons";

interface CustomersClientProps {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canPayment: boolean;
}

interface Customer {
  _id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  status: "active" | "inactive";
  balance?: number;
  createdAt: string;
}

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

const EMPTY_FORM = { name: "", phone: "", email: "", address: "", notes: "", status: "active" as "active" | "inactive" };

export function CustomersClient({ canCreate, canUpdate, canDelete, canPayment }: CustomersClientProps) {
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage] = useState(15);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [payTarget, setPayTarget] = useState<Customer | null>(null);
  const [payForm, setPayForm] = useState({ amount: "", method: "cash", reference: "", note: "", allowOverpay: false });
  const [payErrors, setPayErrors] = useState<Record<string, string>>({});
  const [paying, setPaying] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {

    try {
      const params = new URLSearchParams({
        page: String(page),
        perPage: String(perPage),
        status: statusFilter,
        withBalance: "1",
      });
      if (search) params.set("search", search);
      const res = await fetch(`/api/customers?${params}`);
      if (!res.ok) throw new Error("Failed to load customers");
      const data = await res.json();
      setCustomers(data.customers ?? []);
      setTotal(data.total ?? 0);
    } catch {
      error("Error", "Failed to load customers");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, search, statusFilter]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setErrors({});
    setEditing(null);
    setMode("create");
    setModalOpen(true);
  };

  const openEdit = (customer: Customer) => {
    setForm({
      name: customer.name,
      phone: customer.phone ?? "",
      email: customer.email ?? "",
      address: customer.address ?? "",
      notes: customer.notes ?? "",
      status: customer.status,
    });
    setErrors({});
    setEditing(customer);
    setMode("edit");
    setModalOpen(true);
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Name is required";
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) errs.email = "Invalid email address";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const save = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = {
        ...(mode === "edit" && editing ? { id: editing._id } : {}),
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        address: form.address.trim(),
        notes: form.notes.trim(),
        status: form.status,
      };
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? data?.error ?? "Failed to save customer");
        return;
      }
      success("Success", mode === "create" ? "Customer created" : "Customer updated");
      setModalOpen(false);
      setMode(null);
      load();
    } catch {
      error("Error", "Failed to save customer");
    } finally {
      setSaving(false);
    }
  };

  const openPay = (customer: Customer) => {
    setPayForm({ amount: (customer.balance ?? 0) > 0 ? String((customer.balance ?? 0).toFixed(2)) : "", method: "cash", reference: "", note: "", allowOverpay: false });
    setPayErrors({});
    setPayTarget(customer);
  };

  const submitPayment = async () => {
    if (!payTarget) return;
    const errs: Record<string, string> = {};
    const amount = Number(payForm.amount);
    if (!payForm.amount || isNaN(amount) || amount <= 0) errs.amount = "Enter a valid amount";
    setPayErrors(errs);
    if (Object.keys(errs).length) return;

    setPaying(true);
    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "payment",
          customerId: payTarget._id,
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
      setPayTarget(null);
      load();
    } catch {
      error("Error", "Failed to record payment");
    } finally {
      setPaying(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/customers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", data?.error?.message ?? "Failed to delete customer");
        return;
      }
      success("Success", data.message ?? "Customer deleted");
      setDeleteTarget(null);
      load();
    } catch {
      error("Error", "Failed to delete customer");
    } finally {
      setDeleting(false);
    }
  };

  const totalPages = Math.ceil(total / perPage);

  const columns = [
    {
      key: "name",
      header: "Customer",
      render: (row: Customer) => (
        <Link href={`/customers/${row._id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-blue-600 hover:underline">
          {row.name}
        </Link>
      ),
    },
    { key: "phone", header: "Phone", render: (row: Customer) => row.phone || "—" },
    { key: "email", header: "Email", render: (row: Customer) => row.email || "—" },
    {
      key: "balance",
      header: "Outstanding",
      render: (row: Customer) => {
        const b = row.balance ?? 0;
        return (
          <span className={cn("font-medium", b > 0 ? "text-amber-600" : "text-slate-400")}>
            {money(b)}
          </span>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      render: (row: Customer) => (
        <span className={cn(
          "rounded-full px-2 py-0.5 text-xs font-medium",
          row.status === "active" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"
        )}>
          {row.status}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      className: "w-32",
      render: (row: Customer) => (
        <div className="flex items-center justify-end gap-1">
          {canPayment && row.status === "active" && (
            <button onClick={(e) => { e.stopPropagation(); openPay(row); }} className="rounded-lg px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-50" title="Record payment">
              Pay
            </button>
          )}
          {canUpdate && (
            <button onClick={(e) => { e.stopPropagation(); openEdit(row); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="Edit">
              <Edit className="h-4 w-4" />
            </button>
          )}
          {canDelete && (
            <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(row); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Delete">
              <Trash className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Customers" }]} />
      <PageHeader
        title="Customers"
        description="Customer accounts, balances and payments"
        actions={canCreate ? <Button onClick={openCreate}><Plus className="mr-2 h-4 w-4" />Add Customer</Button> : null}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px]">
          <SearchInput
            value={search}
            onChange={(v) => { setSearch(v); setPage(1); }}
            placeholder="Search by name, phone or email..."
            className="max-w-sm"
          />
        </div>
        <div className="w-36">
          <Select value={statusFilter} onChange={(v) => { setStatusFilter(v); setPage(1); }} options={STATUS_OPTIONS} className="w-full" />
        </div>
      </div>

      <Table
        columns={columns}
        data={customers}
        keyExtractor={(row) => row._id}
        loading={loading}
        empty={<EmptyState label="No customers" description="Create your first customer to get started." />}
      />

      {totalPages > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={totalPages} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}

      {/* Create / Edit modal */}
      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setMode(null); }}
        title={mode === "create" ? "Add Customer" : "Edit Customer"}
        size="md"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => { setModalOpen(false); setMode(null); }}>Cancel</Button>,
          <Button key="save" loading={saving} onClick={save}>{mode === "create" ? "Create" : "Save"}</Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Name" required error={errors.name}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Customer name" />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Phone">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone number" />
            </FormField>
            <FormField label="Email" error={errors.email}>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email (optional)" />
            </FormField>
          </div>
          <FormField label="Address">
            <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Address (optional)" />
          </FormField>
          <FormField label="Notes">
            <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notes (optional)" rows={3} />
          </FormField>
          <FormField label="Status">
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v as "active" | "inactive" })}
              options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]}
            />
          </FormField>
        </div>
      </Modal>

      {/* Payment modal */}
      <Modal
        open={payTarget !== null}
        onClose={() => setPayTarget(null)}
        title={`Record payment — ${payTarget?.name ?? ""}`}
        description={`Outstanding balance: ${money(payTarget?.balance ?? 0)}`}
        size="sm"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setPayTarget(null)}>Cancel</Button>,
          <Button key="pay" loading={paying} onClick={submitPayment}>Record Payment</Button>,
        ]}
      >
        <div className="space-y-4">
          <FormField label="Amount" required error={payErrors.amount}>
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={payForm.amount}
              onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
              placeholder="0.00"
            />
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
          {Number(payForm.amount || 0) > (payTarget?.balance ?? 0) + 0.001 && (
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

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete customer"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? Customers with financial history are deactivated instead.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
