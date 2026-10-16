"use client";

import { useState, useEffect } from "react";
import { SessionUser } from "@/lib/session";
import { Table, EmptyState, Button, Modal, Input, Textarea, FormField, Select } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";
import { Plus, Edit, Trash } from "@/components/ui/icons";

interface BrandsClientProps {
  user: SessionUser;
  canCreate: boolean;
  canDelete: boolean;
}

interface Brand {
  _id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
}

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

export function BrandsClient({ user, canCreate, canDelete }: BrandsClientProps) {
  const [loading, setLoading] = useState(true);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<Brand | null>(null);
  const [form, setForm] = useState({ name: "", description: "", status: "active" as "active" | "inactive" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Brand | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {

    try {
      // all=1 keeps inactive brands visible so they can be edited/reactivated.
      const res = await fetch("/api/brands?all=1");
      if (!res.ok) throw new Error("Failed to load brands");
      setBrands(await res.json());
    } catch {
      error("Error", "Failed to load brands");
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
    setForm({ name: "", description: "", status: "active" });
    setErrors({});
    setEditing(null);
    setMode("create");
    setModalOpen(true);
  };

  const openEdit = (brand: Brand) => {
    setForm({ name: brand.name, description: brand.description, status: brand.status as "active" | "inactive" });
    setErrors({});
    setEditing(brand);
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
        // The brand being edited — was previously read from `deleteTarget`,
        // which is only set by the delete dialog, so every edit sent an empty
        // id and the API created a duplicate instead of updating.
        id: mode === "edit" ? (editing?._id ?? "") : null,
        name: form.name.trim(),
        description: form.description.trim(),
        status: form.status,
      };
      const res = await fetch("/api/brands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to save brand"));
        return;
      }
      success("Success", mode === "create" ? "Brand created" : "Brand updated");
      setModalOpen(false);
      setMode(null);
      setEditing(null);
      load();
    } catch {
      error("Error", "Failed to save brand");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/brands", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to delete brand"));
        return;
      }
      success("Success", "Brand deleted");
      setDeleteTarget(null);
      load();
    } catch {
      error("Error", "Failed to delete brand");
    } finally {
      setDeleting(false);
    }
  };

  const columns = [
    {
      key: "name",
      header: "Brand",
      render: (row: Brand) => <span className="font-medium text-slate-900">{row.name}</span>,
    },
    {
      key: "description",
      header: "Description",
      render: (row: Brand) => row.description || "—",
    },
    {
      key: "status",
      header: "Status",
      render: (row: Brand) => (
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
      render: (row: Brand) => (
        <div className="flex items-center justify-end gap-1">
          {canCreate && (
            <button onClick={(e) => { e.stopPropagation(); openEdit(row); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
              <Edit className="h-4 w-4" />
            </button>
          )}
          {canDelete && (
            <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(row); }} className="rounded-lg p-1.2 text-slate-400 hover:bg-red-50 hover:text-red-600">
              <Trash className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <Breadcrumbs items={[{ label: "Brands" }]} />
      <PageHeader
        title="Brands"
        description="Manage product brands"
        actions={canCreate ? <Button onClick={openCreate}><Plus className="mr-2 h-4 w-4" />Add Brand</Button> : null}
      />

      <Table
        columns={columns}
        data={brands}
        keyExtractor={(row) => row._id}
        loading={loading}
        empty={<EmptyState label="No brands" description="Create your first brand to get started." />}
        onRowClick={(row) => openEdit(row)}
      />

      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setMode(null); }}
        title={mode === "create" ? "Add Brand" : "Edit Brand"}
        size="sm"
        footer={
          [
            <Button key="cancel" variant="secondary" onClick={() => { setModalOpen(false); setMode(null); }}>Cancel</Button>,
            <Button key="save" loading={saving} onClick={save}>{mode === "create" ? "Create" : "Save"}</Button>,
          ]
        }
      >
        <div className="space-y-4">
          <FormField label="Name" required error={errors.name}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Brand name" />
          </FormField>
          <FormField label="Description">
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description (optional)" rows={3} />
          </FormField>
          <FormField label="Status">
            <Select value={form.status} onChange={(v) => setForm({ ...form, status: v as "active" | "inactive" })} options={STATUS_OPTIONS} />
          </FormField>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete brand"
        message={`Are you sure you want to delete "${deleteTarget?.name}"?`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
