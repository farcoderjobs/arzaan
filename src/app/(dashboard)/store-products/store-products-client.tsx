"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, FormField, Input, Select, Textarea, Checkbox, Modal, ConfirmDialog, Pagination, SearchInput, Table, EmptyState, PageHeader } from "@/components/ui";
import { money } from "@/lib/currency";
import { success, error as toastError, warning } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";

interface StoreProductRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  price: number;
  compareAtPrice: number;
  accent: string;
  imageUrl: string;
  category: string;
  stock: number;
  featured: boolean;
  status: "active" | "inactive";
}

const ACCENT_OPTIONS = [
  { value: "indigo", label: "Indigo" },
  { value: "emerald", label: "Emerald" },
  { value: "rose", label: "Rose" },
  { value: "amber", label: "Amber" },
  { value: "sky", label: "Sky" },
  { value: "violet", label: "Violet" },
  { value: "slate", label: "Slate" },
];

const EMPTY_FORM = {
  name: "",
  description: "",
  price: 0,
  compareAtPrice: 0,
  accent: "indigo",
  imageUrl: "",
  category: "General",
  stock: 0,
  featured: false,
  status: "active" as "active" | "inactive",
};

const ACCENT_DOT: Record<string, string> = {
  indigo: "bg-indigo-500",
  emerald: "bg-emerald-500",
  rose: "bg-rose-500",
  amber: "bg-amber-500",
  sky: "bg-sky-500",
  violet: "bg-violet-500",
  slate: "bg-slate-500",
};

export function StoreProductsClient() {
  const [rows, setRows] = useState<StoreProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formId, setFormId] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StoreProductRow | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);

  const perPage = 15;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (search) params.set("search", search);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/store/admin?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRows(data.products ?? []);
      setTotal(data.total ?? 0);
      setTotalPages(data.totalPages ?? 1);
    } catch {
      toastError("Error", "Failed to load store products");
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const openEdit = (row: StoreProductRow) => {
    setFormId(row.id);
    setForm({
      name: row.name,
      description: row.description ?? "",
      price: row.price,
      compareAtPrice: row.compareAtPrice ?? 0,
      accent: row.accent ?? "indigo",
      imageUrl: row.imageUrl ?? "",
      category: row.category ?? "General",
      stock: row.stock ?? 0,
      featured: row.featured ?? false,
      status: row.status,
    });
    setFieldErrors({});
    setFormOpen(true);
  };

  const save = async () => {
    setFieldErrors({});
    if (form.name.trim().length < 2) {
      setFieldErrors({ name: "Name is required (at least 2 characters)" });
      return;
    }
    if (form.price < 0) {
      setFieldErrors({ price: "Price cannot be negative" });
      return;
    }
    if (form.compareAtPrice > 0 && form.compareAtPrice <= form.price) {
      setFieldErrors({ compareAtPrice: "Compare-at price must be higher than the selling price" });
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, id: formId, price: Number(form.price), compareAtPrice: Number(form.compareAtPrice), stock: Number(form.stock) };
      const res = await fetch("/api/store/admin", {
        method: formId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setFieldErrors((data?.error?.details as Record<string, string>) ?? {});
        toastError(formId ? "Update failed" : "Create failed", apiErrorMessage(data, "Please check the form"));
        return;
      }
      success(formId ? "Product updated" : "Product added", form.name);
      setFormOpen(false);
      void load();
    } catch {
      toastError("Error", "Could not save the product");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (row: StoreProductRow, patch: Partial<Pick<StoreProductRow, "status" | "featured">>) => {
    setActionId(row.id);
    try {
      const res = await fetch("/api/store/admin", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, ...patch }),
      });
      const data = await res.json();
      if (!res.ok) {
        toastError("Update failed", apiErrorMessage(data, "Could not update the product"));
        return;
      }
      success("Updated", row.name);
      void load();
    } catch {
      toastError("Error", "Could not update the product");
    } finally {
      setActionId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setActionId(deleteTarget.id);
    try {
      const res = await fetch("/api/store/admin", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        warning("Could not delete", apiErrorMessage(data, "Product not removed"));
        return;
      }
      success("Product removed", deleteTarget.name);
      setDeleteTarget(null);
      void load();
    } catch {
      toastError("Error", "Could not delete the product");
    } finally {
      setActionId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Store Products"
        description="Products shown on the public online store (/). Only products added here are sold online."
        actions={
          <div className="flex items-center gap-2">
            <a
              href="/"
              target="_blank"
              className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              View store ↗
            </a>
            <Link
              href="/store-products/new"
              className="inline-flex h-10 items-center rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700"
            >
              Add product
            </Link>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <SearchInput
          value={search}
          onChange={setSearch}
          onSearch={() => setPage(1)}
          placeholder="Search by name or category…"
          className="w-72"
          loading={loading}
        />
        <Select
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
          options={[
            { value: "", label: "All statuses" },
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]}
          className="w-44"
        />
        <span className="ml-auto text-sm text-slate-500">{total} products</span>
      </div>

      <Table<StoreProductRow>
        columns={[
          {
            key: "name",
            header: "Product",
            render: (r) => (
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg text-white",
                    ACCENT_DOT[r.accent] ?? "bg-indigo-500"
                  )}
                >
                  {r.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.imageUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
                  ) : (
                    <span>🛍️</span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900">
                    {r.name}
                    {r.featured && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">⭐ Featured</span>}
                  </p>
                  <p className="text-xs text-slate-400">{r.category}</p>
                </div>
              </div>
            ),
          },
          { key: "price", header: "Price", className: "text-right", render: (r) => (
            <div>
              <p className="font-semibold text-slate-900">{money(r.price)}</p>
              {r.compareAtPrice > 0 && <p className="text-xs text-slate-400 line-through">{money(r.compareAtPrice)}</p>}
            </div>
          ) },
          { key: "stock", header: "Stock", className: "text-right", render: (r) => (
            <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", r.stock > 5 ? "bg-emerald-100 text-emerald-700" : r.stock > 0 ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700")}>
              {r.stock}
            </span>
          ) },
          {
            key: "status",
            header: "Status",
            render: (r) => (
              <button
                disabled={actionId === r.id}
                onClick={() => toggle(r, { status: r.status === "active" ? "inactive" : "active" })}
                title="Click to toggle"
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-semibold transition hover:opacity-80 disabled:opacity-50",
                  r.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
                )}
              >
                {r.status === "active" ? "● Live" : "○ Hidden"}
              </button>
            ),
          },
          {
            key: "actions",
            header: "Actions",
            render: (r) => (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => toggle(r, { featured: !r.featured })}
                  disabled={actionId === r.id}
                  title={r.featured ? "Remove featured" : "Mark featured"}
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-amber-50 hover:text-amber-600 disabled:opacity-50"
                >
                  ⭐
                </button>
                <button
                  onClick={() => openEdit(r)}
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-blue-50 hover:text-blue-600"
                >
                  ✏️
                </button>
                <button
                  onClick={() => setDeleteTarget(r)}
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                >
                  🗑
                </button>
              </div>
            ),
          },
        ]}
        data={rows}
        keyExtractor={(r) => r.id}
        loading={loading}
        empty={<EmptyState label="No store products yet" description="Click “Add product” to put your first item on the storefront." />}
      />

      {totalPages > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={totalPages} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
        </div>
      )}

      {/* Add / edit modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={formId ? "Edit store product" : "Add store product"}
        description="This product will appear on the public online store at /."
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              {formId ? "Save changes" : "Add product"}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <FormField label="Name" required error={fieldErrors.name}>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Premium Green Tea 250g" />
            </FormField>
          </div>

          <div className="md:col-span-2">
            <FormField label="Description" hint="Shown under the product on the storefront">
              <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Short, appealing description…" />
            </FormField>
          </div>

          <FormField label="Price" required error={fieldErrors.price}>
            <Input type="number" min={0} step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) || 0 })} />
          </FormField>

          <FormField label="Compare-at price" hint="Original price for a strike-through (0 = none)" error={fieldErrors.compareAtPrice}>
            <Input type="number" min={0} step="0.01" value={form.compareAtPrice} onChange={(e) => setForm({ ...form, compareAtPrice: Number(e.target.value) || 0 })} />
          </FormField>

          <FormField label="Category" hint="Free text — used for storefront filters">
            <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. Beverages" />
          </FormField>

          <FormField label="Stock" required hint="Units available to online buyers">
            <Input type="number" min={0} step={1} value={form.stock} onChange={(e) => setForm({ ...form, stock: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
          </FormField>

          <FormField label="Card accent">
            <Select value={form.accent} onChange={(v) => setForm({ ...form, accent: v })} options={ACCENT_OPTIONS} />
          </FormField>

          <FormField label="Image URL" hint="Optional — a colored card is used when empty">
            <Input value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} placeholder="https://…" />
          </FormField>

          <div className="flex flex-wrap items-center gap-6 md:col-span-2">
            <Checkbox checked={form.featured} onChange={(e) => setForm({ ...form, featured: e.target.checked })} label="Featured (shown first with a ⭐ badge)" />
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v as "active" | "inactive" })}
              options={[
                { value: "active", label: "Active — visible on store" },
                { value: "inactive", label: "Inactive — hidden from store" },
              ]}
              className="w-64"
            />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Remove store product?"
        message={deleteTarget ? `"${deleteTarget.name}" will be removed from the online store. This cannot be undone.` : ""}
        confirmLabel="Remove"
        variant="danger"
      />
    </div>
  );
}
