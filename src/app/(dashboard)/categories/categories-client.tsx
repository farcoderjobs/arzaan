"use client";

import { useState, useEffect } from "react";
import { SessionUser } from "@/lib/session";
import { Table, EmptyState, Button, Modal, Input, Textarea, FormField, Select } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";
import { Plus, Edit, Trash, ChevronRight } from "@/components/ui/icons";

interface CategoriesClientProps {
  user: SessionUser;
  canCreate: boolean;
  canDelete: boolean;
}

interface Category {
  _id: string;
  name: string;
  description: string;
  parentId: { _id: string; name: string } | null;
  status: string;
  createdAt: string;
}

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

export function CategoriesClient({ user, canCreate, canDelete }: CategoriesClientProps) {
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<Category[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);
  const [form, setForm] = useState({ name: "", description: "", parentId: "", status: "active" as "active" | "inactive" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {

    try {
      // all=1 keeps inactive categories visible so they can be edited/reactivated.
      const res = await fetch("/api/categories?all=1");
      if (!res.ok) throw new Error("Failed to load categories");
      setCategories(await res.json());
    } catch {
      error("Error", "Failed to load categories");
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
    setForm({ name: "", description: "", parentId: "", status: "active" });
    setErrors({});
    setEditing(null);
    setMode("create");
    setModalOpen(true);
  };

  const openEdit = (cat: Category) => {
    setForm({
      name: cat.name,
      description: cat.description,
      parentId: cat.parentId?._id ?? "",
      status: cat.status as "active" | "inactive",
    });
    setErrors({});
    setEditing(cat);
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
        description: form.description.trim(),
        parentId: form.parentId || null,
        status: form.status,
      };
      const res = await fetch("/api/categories", {
        method: mode === "edit" ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to save category"));
        return;
      }
      success("Success", mode === "create" ? "Category created" : "Category updated");
      setModalOpen(false);
      setMode(null);
      setEditing(null);
      load();
    } catch {
      error("Error", "Failed to save category");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/categories", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to delete category"));
        return;
      }
      success("Success", "Category deleted");
      setDeleteTarget(null);
      load();
    } catch {
      error("Error", "Failed to delete category");
    } finally {
      setDeleting(false);
    }
  };

  const columns = [
    {
      key: "name",
      header: "Category",
      render: (row: Category) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-900">{row.name}</span>
          {row.parentId && <span className="text-xs text-slate-400">/ {row.parentId.name}</span>}
        </div>
      ),
    },
    {
      key: "description",
      header: "Description",
      render: (row: Category) => row.description || "—",
    },
    {
      key: "status",
      header: "Status",
      render: (row: Category) => (
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
      render: (row: Category) => (
        <div className="flex items-center justify-end gap-1">
          {canCreate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                openEdit(row);
              }}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <Edit className="h-4 w-4" />
            </button>
          )}
          {canDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setDeleteTarget(row);
              }}
              className="rounded-lg p-1.2 text-slate-400 hover:bg-red-50 hover:text-red-600"
            >
              <Trash className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <Breadcrumbs items={[{ label: "Categories" }]} />
      <PageHeader
        title="Categories"
        description="Organize products into categories"
        actions={canCreate ? <Button onClick={openCreate}><Plus className="mr-2 h-4 w-4" />Add Category</Button> : null}
      />

      <Table
        columns={columns}
        data={categories}
        keyExtractor={(row) => row._id}
        loading={loading}
        empty={<EmptyState label="No categories" description="Create your first category to get started." />}
        onRowClick={(row) => openEdit(row)}
      />

      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setMode(null); }}
        title={mode === "create" ? "Add Category" : "Edit Category"}
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
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Category name" />
          </FormField>
          <FormField label="Description">
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description (optional)" rows={3} />
          </FormField>
          <FormField label="Parent Category">
            <Select
              value={form.parentId}
              onChange={(v) => setForm({ ...form, parentId: v })}
              options={categories
                .filter((c) => !c.parentId && c._id !== editing?._id)
                .map((c) => ({ value: c._id, label: c.name }))}
              placeholder="No parent (top-level)"
            />
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
        title="Delete category"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
