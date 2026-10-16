"use client";

import { useState, useEffect } from "react";
import { money } from "@/lib/currency";
import { SessionUser } from "@/lib/session";
import { Table, EmptyState, Button, Modal, SearchInput, FormField, Select, Textarea, Input } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";
import { Plus, Edit, ExternalLink, Trash } from "@/components/ui/icons";

interface PurchasesClientProps {
  user: SessionUser;
  canCreate: boolean;
  canCancel: boolean;
}

interface Purchase {
  _id: string;
  purchaseNumber: string;
  supplierId: { _id: string; name: string } | null;
  status: "draft" | "pending" | "completed" | "canceled";
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paidAmount: number;
  dueAmount: number;
  paymentMethod: string;
  note: string;
  createdAt: string;
  items: Array<{ productId: string; name: string; sku: string; quantity: number; purchasePrice: number; subtotal: number }>;
}

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "canceled", label: "Canceled" },
];

export function PurchasesClient({ user, canCreate, canCancel }: PurchasesClientProps) {
  const [loading, setLoading] = useState(true);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage] = useState(15);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "view" | "cancel" | null>(null);
  const [selectedPurchase, setSelectedPurchase] = useState<Purchase | null>(null);
  const [form, setForm] = useState({
    supplierId: "",
    items: [{ productId: "", quantity: 1, purchasePrice: "", discount: 0, tax: 0 }],
    discount: 0,
    tax: 0,
    paymentMethod: "cash" as "cash" | "card" | "transfer" | "check" | "account" | "other",
    paidAmount: 0,
    note: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [suppliers, setSuppliers] = useState<Array<{ _id: string; name: string }>>([]);
  const [products, setProducts] = useState<Array<{ _id: string; name: string; sku: string; sellingPrice: number }>>([]);
  const [detailModalOpen, setDetailModalOpen] = useState(false);

  const load = async (reloadFilters = false) => {

    try {
      const params = new URLSearchParams({
        page: String(page),
        perPage: String(perPage),
        status: statusFilter,
        search,
      });
      const res = await fetch(`/api/purchases?${params}`);
      if (!res.ok) throw new Error("Failed to load purchases");
      const data = await res.json();
      setPurchases(data.purchases ?? []);
      setTotal(data.total ?? 0);
    } catch {
      error("Error", "Failed to load purchases");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void (async () => {
      await load(true);
      const loadFilters = async () => {
        try {
          const [sRes, pRes] = await Promise.all([fetch("/api/suppliers"), fetch("/api/products")]);
          if (sRes.ok) setSuppliers(await sRes.json());
          if (pRes.ok) {
            // /api/products returns { products, total, ... } — not a bare array.
            const body = (await pRes.json()) as { products?: Array<{ _id: string; name: string; sku: string; sellingPrice: number }> };
            const prods = body.products ?? [];
            setProducts(
              prods.map((p) => ({
                _id: p._id,
                name: p.name,
                sku: p.sku,
                sellingPrice: p.sellingPrice,
              }))
            );
          }
        } catch {
          // ignore
        }
      };
      await loadFilters();
    })();
  }, [page, statusFilter, search]);

  const openCreate = () => {
    setSelectedPurchase(null);
    setModalMode("create");
    setForm({
      supplierId: "",
      items: [{ productId: "", quantity: 1, purchasePrice: "", discount: 0, tax: 0 }],
      discount: 0,
      tax: 0,
      paymentMethod: "cash",
      paidAmount: 0,
      note: "",
    });
    setErrors({});
    setModalOpen(true);
  };

  const openView = (purchase: Purchase) => {
    setSelectedPurchase(purchase);
    setDetailModalOpen(true);
  };

  const openCancel = (purchase: Purchase) => {
    setSelectedPurchase(purchase);
    setModalMode("cancel");
    setModalOpen(true);
  };

  const addItem = () => {
    setForm({
      ...form,
      items: [...form.items, { productId: "", quantity: 1, purchasePrice: "", discount: 0, tax: 0 }],
    });
  };

  const removeItem = (index: number) => {
    setForm({
      ...form,
      items: form.items.filter((_, i) => i !== index),
    });
  };

  const updateItem = (index: number, field: string, value: string | number) => {
    const items = [...form.items];
    (items[index] as Record<string, unknown>)[field] = value;
    setForm({ ...form, items });
  };

  const calculateTotal = () => {
    let subtotal = 0;
    for (const item of form.items) {
      if (!item.productId || !item.purchasePrice) continue;
      const qty = Number(item.quantity) || 0;
      const price = Number(item.purchasePrice) || 0;
      subtotal += qty * price;
    }
    const discountAmount = subtotal * (Number(form.discount) / 100);
    const taxAmount = (subtotal - discountAmount) * (Number(form.tax) / 100);
    return { subtotal, discountAmount, taxAmount, total: subtotal - discountAmount + taxAmount };
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.supplierId) errs.supplierId = "Supplier is required";
    if (form.items.length === 0) errs.items = "At least one item is required";
    for (let i = 0; i < form.items.length; i++) {
      const item = form.items[i];
      if (!item.productId) errs[`item_${i}_productId`] = "Product is required";
      if (!item.purchasePrice || isNaN(Number(item.purchasePrice))) errs[`item_${i}_purchasePrice`] = "Price is required";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleCreate = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const calc = calculateTotal();
      const payload = {
        action: "create",
        supplierId: form.supplierId,
        items: form.items.map((i) => ({
          productId: i.productId,
          quantity: Number(i.quantity),
          purchasePrice: Number(i.purchasePrice),
          discount: Number(i.discount) || 0,
          tax: Number(i.tax) || 0,
        })),
        discount: Number(form.discount),
        tax: Number(form.tax),
        paymentMethod: form.paymentMethod,
        paidAmount: Math.min(Number(form.paidAmount), calc.total),
        note: form.note.trim(),
      };
      const res = await fetch("/api/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to create purchase"));
        return;
      }
      success("Success", "Purchase created");
      setModalOpen(false);
      setModalMode(null);
      load();
    } catch {
      error("Error", "Failed to create purchase");
    } finally {
      setSaving(false);
    }
  };

  const handleComplete = async (target?: Purchase) => {
    const purchase = target ?? selectedPurchase;
    if (!purchase) return;
    setCompleting(true);
    try {
      const res = await fetch("/api/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete", id: purchase._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to complete purchase"));
        return;
      }
      success("Success", "Purchase completed");
      setDetailModalOpen(false);
      setSelectedPurchase(null);
      load();
    } catch {
      error("Error", "Failed to complete purchase");
    } finally {
      setCompleting(false);
    }
  };

  const handleCancel = async () => {
    if (!selectedPurchase) return;
    setCancelLoading(true);
    try {
      const res = await fetch("/api/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", id: selectedPurchase._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to cancel purchase"));
        return;
      }
      success("Success", "Purchase canceled");
      setModalOpen(false);
      setModalMode(null);
      setSelectedPurchase(null);
      load();
    } catch {
      error("Error", "Failed to cancel purchase");
    } finally {
      setCancelLoading(false);
    }
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Pending</span>;
      case "completed":
        return <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Completed</span>;
      case "canceled":
        return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Canceled</span>;
      default:
        return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Draft</span>;
    }
  };

  const columns = [
    {
      key: "purchaseNumber",
      header: "PO #",
      render: (row: Purchase) => (
        <button onClick={(e) => { e.stopPropagation(); openView(row); }} className="font-mono text-sm text-blue-600 hover:underline">
          {row.purchaseNumber}
        </button>
      ),
    },
    {
      key: "supplier",
      header: "Supplier",
      render: (row: Purchase) => row.supplierId?.name ?? "—",
    },
    {
      key: "items",
      header: "Items",
      render: (row: Purchase) => (
        <span className="text-sm text-slate-600">{row.items.length} item{row.items.length !== 1 ? "s" : ""}</span>
      ),
    },
    {
      key: "total",
      header: "Total",
      render: (row: Purchase) => (
        <span className="font-medium text-slate-900">{money(Number(row.total))}</span>
      ),
    },
    {
      key: "paid",
      header: "Paid",
      render: (row: Purchase) => (
        <span className="text-sm text-slate-600">{money(Number(row.paidAmount))}</span>
      ),
    },
    {
      key: "due",
      header: "Due",
      render: (row: Purchase) => (
        <span className={cn("text-sm font-medium", Number(row.dueAmount) > 0 ? "text-amber-600" : "text-slate-400")}>
          {money(Number(row.dueAmount))}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row: Purchase) => statusBadge(row.status),
    },
    {
      key: "actions",
      header: "",
      className: "w-20",
      render: (row: Purchase) => (
        <div className="flex items-center justify-end gap-1">
          <button onClick={(e) => { e.stopPropagation(); openView(row); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="View">
            <ExternalLink className="h-4 w-4" />
          </button>
          {canCreate && row.status === "pending" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void handleComplete(row);
              }}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-green-50 hover:text-green-600"
              title="Mark as completed"
            >
              <span className="text-sm leading-none">✓</span>
            </button>
          )}
          {canCancel && row.status === "pending" && (
            <button onClick={(e) => { e.stopPropagation(); openCancel(row); }} className="rounded-lg p-1.2 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Cancel">
              <Trash className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Purchases" }]} />
      <PageHeader
        title="Purchases"
        description="Manage supplier purchases"
        actions={canCreate ? <Button onClick={openCreate}><Plus className="mr-2 h-4 w-4" />New Purchase</Button> : null}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px]">
          <SearchInput
            value={search}
            onChange={setSearch}
            onSearch={() => setPage(1)}
            placeholder="Search by PO number..."
            className="max-w-sm"
          />
        </div>
        <div className="w-36">
          <Select
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1); }}
            options={STATUS_OPTIONS}
            className="w-full"
          />
        </div>
        {(search || statusFilter) && (
          <Button variant="ghost" onClick={() => { setSearch(""); setStatusFilter(""); setPage(1); }}>
            Clear filters
          </Button>
        )}
      </div>

      <Table
        columns={columns}
        data={purchases}
        keyExtractor={(row) => row._id}
        loading={loading}
        empty={<EmptyState label="No purchases" description="Create your first purchase to get started." />}
        onRowClick={(row) => openView(row)}
      />

      {/* Create purchase modal */}
      <Modal
        open={modalOpen && modalMode === "create"}
        onClose={() => { setModalOpen(false); setModalMode(null); }}
        title="New Purchase"
        size="lg"
        footer={
          [
            <Button key="cancel" variant="secondary" onClick={() => { setModalOpen(false); setModalMode(null); }}>Cancel</Button>,
            <Button key="create" loading={saving} onClick={handleCreate}>Create Purchase</Button>,
          ]
        }
      >
        <div className="space-y-4">
          <FormField label="Supplier" required error={errors.supplierId}>
            <Select
              value={form.supplierId}
              onChange={(v) => setForm({ ...form, supplierId: v })}
              options={suppliers.map((s) => ({ value: s._id, label: s.name }))}
              placeholder="Select supplier"
            />
          </FormField>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-slate-700">Items</p>
              <Button variant="ghost" size="sm" onClick={addItem}><Plus className="h-4 w-4 mr-1" />Add Item</Button>
            </div>
            {form.items.map((item, i) => (
              <div key={i} className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <Select
                  value={item.productId}
                  onChange={(v) => updateItem(i, "productId", v)}
                  options={products.map((p) => ({ value: p._id, label: `${p.name} (${p.sku})` }))}
                  placeholder="Select product"
                  className="flex-1"
                />
                <Input
                  type="number"
                  min="1"
                  value={item.quantity}
                  onChange={(e) => updateItem(i, "quantity", e.target.value)}
                  placeholder="Qty"
                  className="w-20"
                />
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={item.purchasePrice}
                  onChange={(e) => updateItem(i, "purchasePrice", e.target.value)}
                  placeholder="Price"
                  className="w-28"
                />
                <Button variant="ghost" size="sm" onClick={() => removeItem(i)} className="text-red-500">✕</Button>
              </div>
            ))}
            {errors.items && <p className="mt-1 text-sm text-red-600">{errors.items}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Discount (%)">
              <Input type="number" min="0" max="100" value={form.discount} onChange={(e) => setForm({ ...form, discount: Number(e.target.value) })} placeholder="0" />
            </FormField>
            <FormField label="Tax (%)">
              <Input type="number" min="0" max="100" value={form.tax} onChange={(e) => setForm({ ...form, tax: Number(e.target.value) })} placeholder="0" />
            </FormField>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-700">Summary</p>
            <div className="mt-2 space-y-1 text-sm">
              <p className="text-slate-600">Subtotal: <span className="font-medium text-slate-900">{money(calculateTotal().subtotal)}</span></p>
              <p className="text-slate-600">Discount: <span className="font-medium text-slate-900">-{money(calculateTotal().discountAmount)}</span></p>
              <p className="text-slate-600">Tax: <span className="font-medium text-slate-900">{money(calculateTotal().taxAmount)}</span></p>
              <p className="text-slate-800 font-semibold text-base">Total: {money(calculateTotal().total)}</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Payment Method">
              <Select
                value={form.paymentMethod}
                onChange={(v) => setForm({ ...form, paymentMethod: v as typeof form.paymentMethod })}
                options={[
                  { value: "cash", label: "Cash" },
                  { value: "card", label: "Card" },
                  { value: "transfer", label: "Bank Transfer" },
                  { value: "check", label: "Check" },
                  { value: "account", label: "Account" },
                  { value: "other", label: "Other" },
                ]}
              />
            </FormField>
            <FormField label="Paid Amount">
              <Input type="number" min="0" step="0.01" value={form.paidAmount} onChange={(e) => setForm({ ...form, paidAmount: Number(e.target.value) })} placeholder="0.00" />
            </FormField>
          </div>

          <FormField label="Notes">
            <Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Notes (optional)" rows={3} />
          </FormField>
        </div>
      </Modal>

      {/* View purchase modal */}
      <Modal
        open={detailModalOpen}
        onClose={() => setDetailModalOpen(false)}
        title={`Purchase ${selectedPurchase?.purchaseNumber}`}
        size="lg"
        footer={[
          canCreate && selectedPurchase?.status === "pending" ? (
            <Button key="complete" loading={completing} onClick={() => void handleComplete()}>Mark as Completed</Button>
          ) : null,
          <Button key="close" variant="secondary" onClick={() => setDetailModalOpen(false)}>Close</Button>,
        ].filter(Boolean) as React.ReactNode[]}
      >
        {selectedPurchase && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500">Supplier</p>
                <p className="font-medium text-slate-900">{selectedPurchase.supplierId?.name ?? "—"}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-500">Status</p>
                <p className="font-medium">{statusBadge(selectedPurchase.status)}</p>
              </div>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-slate-700">Items</p>
              <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
                {selectedPurchase.items.map((item, i) => (
                  <div key={i} className="flex items-center justify-between p-3">
                    <div>
                      <p className="font-medium text-slate-900">{item.name}</p>
                      <p className="text-xs text-slate-500">{item.sku}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-slate-600">{item.quantity} × {money(Number(item.purchasePrice))}</p>
                      <p className="text-sm font-medium text-slate-900">{money(Number(item.subtotal))}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-700">Summary</p>
              <div className="mt-2 space-y-1 text-sm">
                <p className="text-slate-600">Subtotal: <span className="font-medium text-slate-900">{money(Number(selectedPurchase.subtotal))}</span></p>
                <p className="text-slate-600">Discount: <span className="font-medium text-slate-900">-{money(Number(selectedPurchase.discount))}</span></p>
                <p className="text-slate-600">Tax: <span className="font-medium text-slate-900">{money(Number(selectedPurchase.tax))}</span></p>
                <p className="text-slate-800 font-semibold text-base">Total: {money(Number(selectedPurchase.total))}</p>
                <p className="text-slate-600">Paid: <span className="font-medium text-slate-900">{money(Number(selectedPurchase.paidAmount))}</span></p>
                <p className="text-slate-600">Due: <span className={cn("font-medium", Number(selectedPurchase.dueAmount) > 0 ? "text-amber-600" : "text-slate-400")}>{money(Number(selectedPurchase.dueAmount))}</span></p>
              </div>
            </div>

            {selectedPurchase.note && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Notes</p>
                <p className="mt-1 text-sm text-slate-600">{selectedPurchase.note}</p>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={modalOpen && modalMode === "cancel"}
        onClose={() => { setModalOpen(false); setModalMode(null); }}
        onConfirm={handleCancel}
        title="Cancel purchase"
        message={`Are you sure you want to cancel "${selectedPurchase?.purchaseNumber}"?`}
        confirmLabel="Cancel Purchase"
        variant="danger"
        loading={cancelLoading}
      />
    </div>
  );
}
