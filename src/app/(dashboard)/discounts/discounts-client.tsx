"use client";

import { useCallback, useEffect, useState } from "react";
import { Table, EmptyState, Button, Modal, Input, Select, FormField } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";
import { Plus, Edit, Trash, Toggle } from "@/components/ui/icons";

interface DiscountsClientProps {
  canManage: boolean;
}

interface Offer {
  _id: string;
  name: string;
  percentage: number;
  startDate: string;
  endDate: string;
  departmentIds: string[];
  departmentNames: string[];
  categoryIds: string[];
  categoryNames: string[];
  productIds: string[];
  productNames: string[];
  status: "active" | "inactive";
  note: string;
}

interface Option {
  value: string;
  label: string;
}

const emptyForm = {
  name: "",
  percentage: "",
  startDate: "",
  endDate: "",
  status: "active" as "active" | "inactive",
  departmentIds: [] as string[],
  categoryIds: [] as string[],
  productIds: [] as string[],
};

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

/** Scrollable checkbox multi-select used for departments, categories and products. */
function MultiSelect({
  label,
  hint,
  options,
  selected,
  onChange,
}: {
  label: string;
  hint?: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const visible = term
    ? options.filter((o) => o.label.toLowerCase().includes(term))
    : options;

  return (
    <FormField label={label} hint={hint}>
      <div className="rounded-xl border border-slate-200">
        <div className="border-b border-slate-100 p-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            aria-label={`Search ${label}`}
          />
        </div>
        <div className="grid max-h-40 gap-1 overflow-auto p-2 sm:grid-cols-2">
          {visible.length === 0 ? (
            <p className="col-span-full px-1 py-2 text-xs text-slate-400">Nothing to select</p>
          ) : (
            visible.map((option) => (
              <label key={option.value} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={() =>
                    onChange(
                      selected.includes(option.value)
                        ? selected.filter((id) => id !== option.value)
                        : [...selected, option.value]
                    )
                  }
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500/40"
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-500">{selected.length} selected</p>
    </FormField>
  );
}

function isLive(offer: Offer): boolean {
  const now = Date.now();
  return (
    offer.status === "active" &&
    new Date(offer.startDate).getTime() <= now &&
    new Date(offer.endDate).getTime() >= now
  );
}

const day = (value: string) =>
  new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

export function DiscountsClient({ canManage }: DiscountsClientProps) {
  const [loading, setLoading] = useState(true);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<Offer | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Offer | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [departments, setDepartments] = useState<Option[]>([]);
  const [categories, setCategories] = useState<Option[]>([]);
  const [products, setProducts] = useState<Option[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/discounts?all=1");
      if (!res.ok) throw new Error("Failed to load offers");
      const data = await res.json();
      setOffers(data.offers ?? []);
    } catch {
      error("Error", "Failed to load discount offers");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTargets = useCallback(async () => {
    try {
      const [deptRes, catRes, prodRes] = await Promise.all([
        fetch("/api/departments?all=1"),
        fetch("/api/categories?all=1"),
        fetch("/api/products?perPage=100&status=active"),
      ]);
      if (deptRes.ok) {
        const data = await deptRes.json();
        setDepartments(
          ((data.departments ?? []) as Array<{ _id: string; name: string; status?: string }>)
            .filter((d) => d.status !== "inactive")
            .map((d) => ({ value: d._id, label: d.name }))
        );
      }
      if (catRes.ok) {
        const data = (await catRes.json()) as Array<{ _id: string; name: string }>;
        setCategories(data.map((c) => ({ value: c._id, label: c.name })));
      }
      if (prodRes.ok) {
        const data = await prodRes.json();
        setProducts(
          ((data.products ?? []) as Array<{ _id: string; name: string; sku?: string }>).map((p) => ({
            value: p._id,
            label: p.sku ? `${p.name} (${p.sku})` : p.name,
          }))
        );
      }
    } catch {
      // The selects simply stay empty; the API still validates the ids.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadTargets();
  }, [load, loadTargets]);

  const openCreate = () => {
    setEditing(null);
    setMode("create");
    setForm(emptyForm);
    setErrors({});
    setModalOpen(true);
  };

  const openEdit = (offer: Offer) => {
    setEditing(offer);
    setMode("edit");
    setForm({
      name: offer.name,
      percentage: String(offer.percentage),
      startDate: offer.startDate.slice(0, 10),
      endDate: offer.endDate.slice(0, 10),
      status: offer.status,
      departmentIds: offer.departmentIds,
      categoryIds: offer.categoryIds,
      productIds: offer.productIds,
    });
    setErrors({});
    setModalOpen(true);
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Offer name is required";
    const percentage = Number(form.percentage);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      errs.percentage = "Enter a percentage between 0.01 and 100";
    }
    if (!form.startDate) errs.startDate = "Start date is required";
    if (!form.endDate) errs.endDate = "End date is required";
    if (form.startDate && form.endDate && form.endDate < form.startDate) {
      errs.endDate = "End date cannot be before the start date";
    }
    if (form.departmentIds.length + form.categoryIds.length + form.productIds.length === 0) {
      errs.targets = "Select at least one department, category or product";
    }
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
        percentage: Number(form.percentage),
        startDate: form.startDate,
        endDate: form.endDate,
        status: form.status,
        departmentIds: form.departmentIds,
        categoryIds: form.categoryIds,
        productIds: form.productIds,
      };
      const res = await fetch("/api/discounts", {
        method: mode === "edit" ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to save discount offer"));
        return;
      }
      success("Success", mode === "create" ? "Discount offer created" : "Discount offer updated");
      setModalOpen(false);
      setMode(null);
      setEditing(null);
      void load();
    } catch {
      error("Error", "Failed to save discount offer");
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (offer: Offer) => {
    setBusyId(offer._id);
    try {
      const next = offer.status === "active" ? "inactive" : "active";
      const res = await fetch("/api/discounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: offer._id, status: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to update offer"));
        return;
      }
      success("Success", next === "active" ? "Offer activated" : "Offer deactivated");
      void load();
    } catch {
      error("Error", "Failed to update offer");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/discounts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to delete offer"));
        return;
      }
      success("Success", "Discount offer deleted");
      setDeleteTarget(null);
      void load();
    } catch {
      error("Error", "Failed to delete offer");
    } finally {
      setDeleting(false);
    }
  };

  const targetSummary = (offer: Offer) => {
    const parts: string[] = [];
    if (offer.departmentIds.length > 0) {
      parts.push(
        offer.departmentNames.length > 0 && offer.departmentNames.length <= 2
          ? `Departments: ${offer.departmentNames.join(", ")}`
          : `${offer.departmentIds.length} department${offer.departmentIds.length === 1 ? "" : "s"}`
      );
    }
    if (offer.categoryIds.length > 0) {
      parts.push(
        offer.categoryNames.length > 0 && offer.categoryNames.length <= 2
          ? `Categories: ${offer.categoryNames.join(", ")}`
          : `${offer.categoryIds.length} categor${offer.categoryIds.length === 1 ? "y" : "ies"}`
      );
    }
    if (offer.productIds.length > 0) {
      parts.push(
        offer.productNames.length > 0 && offer.productNames.length <= 2
          ? `Products: ${offer.productNames.join(", ")}`
          : `${offer.productIds.length} product${offer.productIds.length === 1 ? "" : "s"}`
      );
    }
    return parts.length > 0 ? parts.join(" · ") : "—";
  };

  const columns = [
    {
      key: "name",
      header: "Offer",
      render: (row: Offer) => (
        <div>
          <p className="font-medium text-slate-900">{row.name}</p>
          <p className="text-xs text-slate-400">{day(row.startDate)} – {day(row.endDate)}</p>
        </div>
      ),
    },
    {
      key: "percentage",
      header: "Discount",
      render: (row: Offer) => (
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
          {row.percentage}%
        </span>
      ),
    },
    {
      key: "targets",
      header: "Applies to",
      render: (row: Offer) => <span className="text-xs text-slate-600">{targetSummary(row)}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (row: Offer) => {
        const live = isLive(row);
        return (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              live
                ? "bg-green-100 text-green-700"
                : row.status === "inactive"
                  ? "bg-slate-100 text-slate-600"
                  : "bg-amber-100 text-amber-700"
            )}
          >
            {live ? "Running" : row.status === "inactive" ? "Inactive" : "Scheduled/Expired"}
          </span>
        );
      },
    },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "",
            className: "w-28",
            render: (row: Offer) => (
              <div className="flex items-center justify-end gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openEdit(row);
                  }}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  title="Edit"
                >
                  <Edit className="h-4 w-4" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleStatus(row);
                  }}
                  disabled={busyId === row._id}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
                  title={row.status === "active" ? "Deactivate" : "Activate"}
                >
                  <Toggle className="h-4 w-4" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(row);
                  }}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  title="Delete"
                >
                  <Trash className="h-4 w-4" />
                </button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Discounts" }]} />
      <PageHeader
        title="Discounts"
        description="Time-boxed percentage offers for departments, categories and products — applied automatically at the POS"
        actions={
          canManage ? (
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              Add Offer
            </Button>
          ) : null
        }
      />

      <Table
        columns={columns}
        data={offers}
        keyExtractor={(row) => row._id}
        loading={loading}
        empty={
          <EmptyState
            label="No discount offers"
            description="Create an offer and its products will be discounted at the POS for the selected days."
          />
        }
        onRowClick={canManage ? openEdit : undefined}
      />

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setMode(null);
          setEditing(null);
          setErrors({});
        }}
        title={mode === "create" ? "Add Discount Offer" : "Edit Discount Offer"}
        size="lg"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>,
          <Button key="save" loading={saving} onClick={save}>
            {mode === "create" ? "Create Offer" : "Save Changes"}
          </Button>,
        ]}
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Offer Name" required error={errors.name}>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Detergent week"
              />
            </FormField>
            <FormField label="Discount (%)" required error={errors.percentage}>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                max="100"
                value={form.percentage}
                onChange={(e) => setForm({ ...form, percentage: e.target.value })}
                placeholder="5"
              />
            </FormField>
            <FormField label="Status">
              <Select
                value={form.status}
                onChange={(v) => setForm({ ...form, status: v as "active" | "inactive" })}
                options={STATUS_OPTIONS}
              />
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Start Date" required error={errors.startDate}>
              <Input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              />
            </FormField>
            <FormField label="End Date" required error={errors.endDate} hint="The offer is live for the whole end date.">
              <Input
                type="date"
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
              />
            </FormField>
          </div>

          {errors.targets && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{errors.targets}</p>
          )}

          <MultiSelect
            label="Departments"
            hint="Every product in the selected departments receives this offer."
            options={departments}
            selected={form.departmentIds}
            onChange={(departmentIds) => setForm({ ...form, departmentIds })}
          />
          <MultiSelect
            label="Categories"
            hint="Every product in the selected categories receives this offer."
            options={categories}
            selected={form.categoryIds}
            onChange={(categoryIds) => setForm({ ...form, categoryIds })}
          />
          <MultiSelect
            label="Products"
            hint="Only the selected products receive this offer. A product matched by any list is discounted once, at the highest offer."
            options={products}
            selected={form.productIds}
            onChange={(productIds) => setForm({ ...form, productIds })}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete discount offer"
        message={`Delete "${deleteTarget?.name ?? ""}"? Products will no longer receive this discount at the POS.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
