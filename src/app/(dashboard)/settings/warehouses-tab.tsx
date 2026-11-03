"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, FormField, Input, Modal, Select } from "@/components/ui";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { money } from "@/lib/currency";
import { cn } from "@/utils/classname";

interface WarehouseRow {
  _id: string;
  name: string;
  code: string;
  address: string;
  phone: string;
  status: "active" | "inactive";
  note: string;
  itemCount: number;
  units: number;
  stockValue: number;
}

const EMPTY_WAREHOUSE = {
  name: "",
  code: "",
  address: "",
  phone: "",
  note: "",
  status: "active" as "active" | "inactive",
};

/**
 * Warehouses are their own entity — they are not branches. They hold stock and
 * never sell, so they have no register, staff or department here.
 */
export function WarehousesTab({ canManage }: { canManage: boolean }) {
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WarehouseRow | null>(null);
  const [form, setForm] = useState(EMPTY_WAREHOUSE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/warehouses");
      if (!res.ok) return;
      const data = await res.json();
      setWarehouses(data.warehouses ?? []);
    } catch {
      error("Error", "Failed to load warehouses");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const openCreate = () => {
    setForm(EMPTY_WAREHOUSE);
    setErrors({});
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (row: WarehouseRow) => {
    setForm({
      name: row.name,
      code: row.code,
      address: row.address,
      phone: row.phone,
      note: row.note,
      status: row.status,
    });
    setErrors({});
    setEditing(row);
    setModalOpen(true);
  };

  const save = async () => {
    const errs: Record<string, string> = {};
    if (form.name.trim().length < 2) errs.name = "Warehouse name is required";
    if (form.code && !/^[A-Za-z0-9_-]{1,20}$/.test(form.code.trim())) errs.code = "1-20 chars: letters, numbers, - and _";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    try {
      const payload = editing
        ? { action: "update", id: editing._id, ...form }
        : { action: "create", ...form };
      const res = await fetch("/api/warehouses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to save warehouse"));
        return;
      }
      success("Saved", editing ? "Warehouse updated" : "Warehouse created");
      setModalOpen(false);
      await load();
    } catch {
      error("Error", "Failed to save warehouse");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-4 sm:px-5">
        <div>
          <h3 className="font-semibold text-slate-900">Warehouses</h3>
          <p className="text-xs text-slate-500">
            Standalone stock locations — not branches. They never sell; stock moves in and out through transfers.
          </p>
        </div>
        {canManage && <Button onClick={openCreate}>Add warehouse</Button>}
      </div>

      {loading ? (
        <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>
      ) : warehouses.length === 0 ? (
        <EmptyState
          label="No warehouses"
          description="Add a warehouse to keep bulk stock outside your selling shops."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-4 py-3 font-semibold">Warehouse</th>
                <th className="px-4 py-3 font-semibold">Code</th>
                <th className="px-4 py-3 font-semibold">Items</th>
                <th className="px-4 py-3 font-semibold">Units</th>
                <th className="px-4 py-3 font-semibold">Stock value</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                {canManage && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody>
              {warehouses.map((w) => (
                <tr key={w._id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{w.name}</p>
                    {w.address && <p className="text-xs text-slate-400">{w.address}</p>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{w.code || "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{w.itemCount}</td>
                  <td className="px-4 py-3 text-slate-600">{w.units}</td>
                  <td className="px-4 py-3 text-slate-600">{money(w.stockValue ?? 0)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        w.status === "active" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"
                      )}
                    >
                      {w.status}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(w)}>
                        Edit
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Edit warehouse — ${editing.name}` : "Add warehouse"}
        size="md"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>,
          <Button key="save" loading={saving} onClick={() => void save()}>
            {editing ? "Save" : "Create"}
          </Button>,
        ]}
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Warehouse name" required error={errors.name}>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Main Warehouse"
              />
            </FormField>
            <FormField label="Code" error={errors.code}>
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                placeholder="e.g. WH01"
              />
            </FormField>
          </div>
          <FormField label="Address">
            <Input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="Street address"
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Phone">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone" />
            </FormField>
            <FormField label="Status">
              <Select
                value={form.status}
                onChange={(v) => setForm({ ...form, status: v as "active" | "inactive" })}
                options={[
                  { value: "active", label: "Active" },
                  { value: "inactive", label: "Inactive" },
                ]}
              />
            </FormField>
          </div>
          <FormField label="Note">
            <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Optional note" />
          </FormField>
        </div>
      </Modal>
    </div>
  );
}
