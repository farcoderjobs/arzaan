"use client";

import { useState, useEffect } from "react";
import { SessionUser } from "@/lib/session";
import { Table, EmptyState, Button, Modal, Input, Textarea, FormField, Select } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { money } from "@/lib/currency";
import { cn } from "@/utils/classname";
import { Plus, Edit, Trash, ExternalLink } from "@/components/ui/icons";

interface SuppliersClientProps {
  user: SessionUser;
  canCreate: boolean;
  canDelete: boolean;
}

interface Supplier {
  _id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  note: string;
  status: string;
  /** Outstanding payable (money we owe the supplier), when requested. */
  balance?: number;
  createdAt: string;
}

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

export function SuppliersClient({ user, canCreate, canDelete }: SuppliersClientProps) {
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", address: "", note: "", status: "active" as "active" | "inactive" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Supplier | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {

    try {
      // all=1 keeps inactive suppliers visible so they can be edited/reactivated.
      // withBalance=1 attaches each supplier's outstanding payable.
      const res = await fetch("/api/suppliers?all=1&withBalance=1");
      if (!res.ok) throw new Error("Failed to load suppliers");
      setSuppliers(await res.json());
    } catch {
      error("Error", "Failed to load suppliers");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, []);

  const openCreate = () => {
    setForm({ name: "", phone: "", email: "", address: "", note: "", status: "active" });
    setErrors({});
    setEditing(null);
    setMode("create");
    setModalOpen(true);
  };

  const openEdit = (s: Supplier) => {
    setForm({ name: s.name, phone: s.phone, email: s.email, address: s.address, note: s.note, status: s.status as "active" | "inactive" });
    setErrors({});
    setEditing(s);
    setMode("edit");
    setModalOpen(true);
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Name is required";
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
        email: form.email.trim().toLowerCase(),
        address: form.address.trim(),
        note: form.note.trim(),
        status: form.status,
      };
      const res = await fetch("/api/suppliers", {
        method: mode === "edit" ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to save supplier"));
        return;
      }
      success("Success", mode === "create" ? "Supplier created" : "Supplier updated");
      setModalOpen(false);
      setMode(null);
      load();
    } catch {
      error("Error", "Failed to save supplier");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/suppliers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to delete supplier"));
        return;
      }
      success("Success", "Supplier deleted");
      setDeleteTarget(null);
      load();
    } catch {
      error("Error", "Failed to delete supplier");
    } finally {
      setDeleting(false);
    }
  };

  const columns = [
    {
      key: "name",
      header: "Supplier",
      render: (row: Supplier) => (
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-sm">S</div>
          <span className="font-medium text-slate-900">{row.name}</span>
        </div>
      ),
    },
    {
      key: "contact",
      header: "Contact",
      render: (row: Supplier) => (
        <div>
          <p className="text-sm text-slate-600">{row.email || "—"}</p>
          <p className="text-sm text-slate-500">{row.phone || "—"}</p>
        </div>
      ),
    },
    {
      key: "address",
      header: "Address",
      render: (row: Supplier) => <span className="text-sm text-slate-600 truncate max-w-[180px] block">{row.address || "—"}</span>,
    },
    {
      key: "balance",
      header: "Outstanding",
      render: (row: Supplier) => {
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
      render: (row: Supplier) => (
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
      className: "w-20",
      render: (_row: Supplier) => (
        <div className="flex items-center justify-end gap-1">
          {canCreate && (
            <button onClick={(e: React.MouseEvent) => { e.stopPropagation(); openEdit(_row); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
              <Edit className="h-4 w-4" />
            </button>
          )}
          {canDelete && (
            <button onClick={(e: React.MouseEvent) => { e.stopPropagation(); setDeleteTarget(_row); }} className="rounded-lg p-1.2 text-slate-400 hover:bg-red-50 hover:text-red-600">
              <Trash className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumbs items={[{ label: "Suppliers" }]} />
      <PageHeader
        title="Suppliers"
        description="Manage your supplier list"
        actions={canCreate ? <Button onClick={openCreate}><Plus className="mr-2 h-4 w-4" />Add Supplier</Button> : null}
      />

      <Table
        columns={columns}
        data={suppliers}
        keyExtractor={(row) => row._id}
        loading={loading}
        empty={<EmptyState label="No suppliers" description="Add your first supplier to get started." />}
        onRowClick={(row: Supplier) => openEdit(row)}
      />

      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setMode(null); }}
        title={mode === "create" ? "Add Supplier" : "Edit Supplier"}
        size="md"
        footer={
          [
            <Button key="cancel" variant="secondary" onClick={() => { setModalOpen(false); setMode(null); }}>Cancel</Button>,
            <Button key="save" loading={saving} onClick={save}>{mode === "create" ? "Create" : "Save"}</Button>,
          ]
        }
      >
        <div className="space-y-4">
          <FormField label="Name" required error={errors.name}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Supplier name" />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Email">
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
            </FormField>
            <FormField label="Phone">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+1 234 567 890" />
            </FormField>
          </div>
          <FormField label="Address">
            <Textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Address (optional)" rows={2} />
          </FormField>
          <FormField label="Notes">
            <Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Notes (optional)" rows={3} />
          </FormField>
          <FormField label="Status">
            <Select value={form.status} onChange={(v: unknown) => setForm({ ...form, status: v as "active" | "inactive" })} options={STATUS_OPTIONS} />
          </FormField>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete supplier"
        message={`Are you sure you want to delete "${deleteTarget?.name}"?`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
