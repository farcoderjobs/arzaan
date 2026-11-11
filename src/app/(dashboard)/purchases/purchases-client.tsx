"use client";

import { useState, useEffect } from "react";
import { money } from "@/lib/currency";
import { SessionUser } from "@/lib/session";
import { Table, EmptyState, Button, Modal, SearchInput, FormField, Select, Textarea, Input } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { success, error, warning } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";
import { Plus, ExternalLink, Trash } from "@/components/ui/icons";
import { BarcodePrintSheet, BarcodeSvg, LABEL_SIZES, type LabelSize } from "@/components/barcode-label";

interface PurchasesClientProps {
  user: SessionUser;
  canCreate: boolean;
  canCancel: boolean;
}

interface Purchase {
  _id: string;
  purchaseNumber: string;
  supplierId: { _id: string; name: string } | null;
  purchaseSource?: "import" | "local";
  /** Where the received stock landed: the shop or a warehouse. */
  locationType?: "shop" | "warehouse";
  warehouseId?: { _id?: string; name?: string } | string | null;
  /** Populated by the API for warehouse receipts. */
  warehouseName?: string | null;
  /** Department (mini-store) a local purchase was bought for; "Shop" is default. */
  departmentId?: string | null;
  departmentName?: string;
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
  type PurchaseLine = {
    productId: string;
    productQuery: string;
    quantity: number;
    purchasePrice: string;
    discount: number;
    tax: number;
    expirationDate: string;
    batchNumber: string;
  };

  const emptyLine = (): PurchaseLine => ({
    productId: "",
    productQuery: "",
    quantity: 1,
    purchasePrice: "",
    discount: 0,
    tax: 0,
    expirationDate: "",
    batchNumber: "",
  });

  const [form, setForm] = useState<{
    supplierId: string;
    items: PurchaseLine[];
    discount: number;
    tax: number;
    paymentMethod: "cash" | "card" | "transfer" | "check" | "account" | "other";
    paidAmount: number;
    note: string;
    /** Receive into the shop (POS-sellable) or a warehouse (reserve stock). */
    locationType: "shop" | "warehouse";
    warehouseId: string;
  }>({
    supplierId: "",
    items: [emptyLine()],
    discount: 0,
    tax: 0,
    paymentMethod: "cash" as "cash" | "card" | "transfer" | "check" | "account" | "other",
    paidAmount: 0,
    note: "",
    locationType: "shop",
    warehouseId: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [suppliers, setSuppliers] = useState<Array<{ _id: string; name: string }>>([]);
  const [warehouses, setWarehouses] = useState<Array<{ _id: string; name: string }>>([]);
  const [detailModalOpen, setDetailModalOpen] = useState(false);

  // Print barcode (Purchases module)
  const [printOpen, setPrintOpen] = useState(false);
  const [printQuery, setPrintQuery] = useState("");
  const [printResults, setPrintResults] = useState<Array<{ id: string; name: string; sku: string; barcode: string; price: number; variantName?: string }>>([]);
  const [printSearching, setPrintSearching] = useState(false);
  const [printProduct, setPrintProduct] = useState<{ id: string; name: string; sku: string; barcode: string; price: number; variantName?: string } | null>(null);
  const [printCopies, setPrintCopies] = useState(1);
  const [printSize, setPrintSize] = useState<LabelSize>("38x25");
  const [printShowPrice, setPrintShowPrice] = useState(true);

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
          const sRes = await fetch("/api/suppliers");
          if (sRes.ok) setSuppliers(await sRes.json());
          const wRes = await fetch("/api/warehouses");
          if (wRes.ok) {
            const body = (await wRes.json()) as {
              warehouses?: Array<{ _id: string; name: string; status?: string }>;
            };
            setWarehouses((body.warehouses ?? []).filter((w) => w.status !== "inactive"));
          }
        } catch {
          // ignore
        }
      };
      await loadFilters();
    })();
  }, [page, statusFilter, search]);

  // Barcode/name/SKU product search for the print-label flow.
  useEffect(() => {
    const term = printOpen && !printProduct ? printQuery.trim() : "";
    if (!term) {
      const clearTimer = setTimeout(() => setPrintResults([]), 0);
      return () => clearTimeout(clearTimer);
    }
    const timer = setTimeout(async () => {
      setPrintSearching(true);
      try {
        const res = await fetch(`/api/products?search=${encodeURIComponent(term)}&perPage=10`);
        if (!res.ok) return;
        const body = (await res.json()) as {
          products?: Array<{ _id: string; name: string; sku: string; barcode?: string; sellingPrice?: number; variantName?: string }>;
        };
        setPrintResults(
          (body.products ?? []).map((p) => ({
            id: p._id,
            name: p.name,
            sku: p.sku,
            barcode: p.barcode ?? "",
            price: p.sellingPrice ?? 0,
            variantName: p.variantName,
          }))
        );
      } catch {
        // ignore — the modal shows the empty state
      } finally {
        setPrintSearching(false);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [printQuery, printOpen, printProduct]);

  const openCreate = () => {
    setSelectedPurchase(null);
    setModalMode("create");
    setForm({
      supplierId: "",
      items: [emptyLine()],
      discount: 0,
      tax: 0,
      paymentMethod: "cash",
      paidAmount: 0,
      note: "",
      locationType: "shop",
      warehouseId: "",
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
    setForm({ ...form, items: [...form.items, emptyLine()] });
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
    if (form.locationType === "warehouse" && !form.warehouseId) {
      errs.warehouseId = "Select the warehouse that receives this purchase";
    }
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
        locationType: form.locationType,
        warehouseId: form.locationType === "warehouse" ? form.warehouseId : null,
        items: form.items.map((i) => ({
          productId: i.productId,
          quantity: Number(i.quantity),
          purchasePrice: Number(i.purchasePrice),
          discount: Number(i.discount) || 0,
          tax: Number(i.tax) || 0,
          expirationDate: i.expirationDate || null,
          batchNumber: i.batchNumber.trim(),
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
      key: "source",
      header: "Source",
      render: (row: Purchase) => (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            row.purchaseSource === "import"
              ? "bg-indigo-100 text-indigo-700"
              : row.purchaseSource === "local"
                ? "bg-emerald-100 text-emerald-700"
                : "bg-slate-100 text-slate-600"
          )}
        >
          {row.purchaseSource === "import"
            ? "Import (China)"
            : row.purchaseSource === "local"
              ? "Local"
              : "Unspecified"}
        </span>
      ),
    },
    {
      key: "destination",
      header: "Received into",
      render: (row: Purchase) =>
        row.locationType === "warehouse" ? (
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
            {row.warehouseName
              ?? (typeof row.warehouseId === "object" && row.warehouseId?.name)
              ?? "Warehouse"}
          </span>
        ) : (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Shop</span>
        ),
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
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => { setPrintProduct(null); setPrintQuery(""); setPrintOpen(true); }}>
              Print Barcode
            </Button>
            {canCreate ? (
              <Button onClick={openCreate}><Plus className="mr-2 h-4 w-4" />New Purchase</Button>
            ) : null}
          </div>
        }
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

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Receive into"
              required
              hint="Shop stock is sold at the POS; warehouse stock stays in reserve until transferred"
            >
              <Select
                value={form.locationType}
                onChange={(v) =>
                  setForm({
                    ...form,
                    locationType: v as "shop" | "warehouse",
                    warehouseId: v === "shop" ? "" : form.warehouseId,
                  })
                }
                options={[
                  { value: "shop", label: "Shop" },
                  { value: "warehouse", label: "Warehouse" },
                ]}
              />
            </FormField>
            {form.locationType === "warehouse" && (
              <FormField label="Warehouse" required error={errors.warehouseId}>
                <Select
                  value={form.warehouseId}
                  onChange={(v) => setForm({ ...form, warehouseId: v })}
                  options={warehouses.map((w) => ({ value: w._id, label: w.name }))}
                  placeholder="Select warehouse"
                />
              </FormField>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-slate-700">Items</p>
              <Button variant="ghost" size="sm" onClick={addItem}><Plus className="h-4 w-4 mr-1" />Add Item</Button>
            </div>
            {form.items.map((item, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-[220px] flex-1">
                    <ProductPicker
                      query={item.productQuery}
                      error={errors[`item_${i}_productId`]}
                      onQueryChange={(value) => updateItem(i, "productQuery", value)}
                      onSelect={(product) => {
                        // Never create a duplicate line for the same product
                        // AND batch: merge the quantity into that line. A
                        // different expiry/batch is a genuinely separate
                        // received batch, so it stays on its own line.
                        const duplicateIndex = form.items.findIndex(
                          (line, index) =>
                            index !== i &&
                            line.productId === product._id &&
                            line.expirationDate === item.expirationDate &&
                            line.batchNumber.trim().toLowerCase() === item.batchNumber.trim().toLowerCase()
                        );
                        if (duplicateIndex !== -1) {
                          const merged = [...form.items];
                          merged[duplicateIndex] = {
                            ...merged[duplicateIndex],
                            quantity: Number(merged[duplicateIndex].quantity) + Number(item.quantity || 1),
                          };
                          merged.splice(i, 1);
                          setForm({ ...form, items: merged });
                          warning("Already added", `${product.name} was merged into the existing line`);
                          return;
                        }
                        const rows = [...form.items];
                        rows[i] = {
                          ...rows[i],
                          productId: product._id,
                          productQuery: `${product.name} (${product.sku})`,
                          purchasePrice: rows[i].purchasePrice || String(product.costPrice ?? ""),
                        };
                        setForm({ ...form, items: rows });
                        setErrors((prev) => {
                          const next = { ...prev };
                          delete next[`item_${i}_productId`];
                          return next;
                        });
                      }}
                    />
                  </div>
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
                    placeholder="Unit cost"
                    className="w-28"
                  />
                  <Button variant="ghost" size="sm" onClick={() => removeItem(i)} className="text-red-500">✕</Button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                    Expiration date (this batch)
                    <Input
                      type="date"
                      value={item.expirationDate}
                      onChange={(e) => updateItem(i, "expirationDate", e.target.value)}
                      className="w-44"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                    Batch # (optional)
                    <Input
                      value={item.batchNumber}
                      onChange={(e) => updateItem(i, "batchNumber", e.target.value)}
                      placeholder="Auto from PO #"
                      className="w-44"
                    />
                  </label>
                  <p className="pb-2 text-xs text-slate-400">
                    Batches without an expiry date behave like normal stock.
                  </p>
                </div>
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
                <p className="mt-1 text-xs text-slate-500">
                  Department: {selectedPurchase.departmentName || "Shop"}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Received into:{" "}
                  {selectedPurchase.locationType === "warehouse"
                    ? selectedPurchase.warehouseName
                      ?? (typeof selectedPurchase.warehouseId === "object" && selectedPurchase.warehouseId?.name)
                      ?? "Warehouse"
                    : "Shop"}
                </p>
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

      {/* Print barcode labels */}
      <Modal
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        title="Print Barcode"
        size="md"
        footer={
          [
            <Button key="close" variant="secondary" onClick={() => setPrintOpen(false)}>Close</Button>,
            <Button
              key="print"
              disabled={!printProduct?.barcode}
              onClick={() => {
                if (!printProduct?.barcode) {
                  warning("No barcode", "Generate a barcode for this product from the Products screen first.");
                  return;
                }
                window.print();
              }}
            >
              Print labels
            </Button>,
          ]
        }
      >
        <div className="space-y-4">
          <FormField label="Find product" hint="Search by name, SKU or barcode — scanners can type into this field">
            <div className="relative">
              <Input
                value={printQuery}
                onChange={(e) => setPrintQuery(e.target.value)}
                placeholder="Search product…"
                autoFocus
              />
              {(printResults.length > 0 || printSearching) && printQuery.trim() && !printProduct && (
                <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                  {printSearching && <li className="px-3 py-2 text-sm text-slate-400">Searching…</li>}
                  {printResults.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPrintProduct(p);
                          setPrintQuery(`${p.name} (${p.sku})`);
                          setPrintResults([]);
                        }}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-900">{p.name}</span>
                          <span className="block text-xs text-slate-400">{p.sku}{p.barcode ? ` · ${p.barcode}` : " · no barcode"}</span>
                        </span>
                        <span className="shrink-0 text-xs text-slate-500">{money(p.price)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </FormField>

          {printProduct && (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900">{printProduct.name}</p>
                  <p className="text-xs text-slate-500">
                    {printProduct.sku} · {printProduct.barcode || "No barcode assigned"}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => { setPrintProduct(null); setPrintQuery(""); }}>
                  Change
                </Button>
              </div>
              {printProduct.barcode ? (
                <div className="rounded bg-white p-2">
                  <BarcodeSvg value={printProduct.barcode} height={44} fontSize={10} />
                </div>
              ) : (
                <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  This product has no barcode yet. Open Products → 🏷️ to generate one.
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField label="Number of labels">
                  <Input
                    type="number"
                    min={1}
                    max={200}
                    value={printCopies}
                    onChange={(e) => setPrintCopies(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                  />
                </FormField>
                <FormField label="Label size">
                  <Select
                    value={printSize}
                    onChange={(v) => setPrintSize(v as LabelSize)}
                    options={LABEL_SIZES.map((s) => ({ value: s.value, label: s.label }))}
                  />
                </FormField>
                <FormField label="Price on label">
                  <Select
                    value={printShowPrice ? "yes" : "no"}
                    onChange={(v) => setPrintShowPrice(v === "yes")}
                    options={[{
                      value: "yes", label: "Show price" }, { value: "no", label: "Hide price" }]}
                  />
                </FormField>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* Print-only labels — generated labels scan back to this product code */}
      {printProduct && printProduct.barcode && (
        <BarcodePrintSheet
          product={{
            productName: printProduct.name,
            sku: printProduct.sku,
            barcode: printProduct.barcode,
            price: printProduct.price,
            variantName: printProduct.variantName,
          }}
          copies={printCopies}
          size={printSize}
          showPrice={printShowPrice}
        />
      )}

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

type PickerProduct = {
  _id: string;
  name: string;
  sku: string;
  barcode?: string;
  costPrice?: number;
  sellingPrice?: number;
};

/**
 * Product picker used by purchase lines.
 *
 * Searches the server by name, SKU or barcode and supports USB barcode
 * scanners: they type the code into this focused input and send Enter, which
 * selects the exact barcode/SKU match (or the first result).
 */
function ProductPicker({
  query,
  onQueryChange,
  onSelect,
  error,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (product: PickerProduct) => void;
  error?: string;
}) {
  const [results, setResults] = useState<PickerProduct[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = query.trim();
    // "Name (SKU)" means a product was already selected — nothing to search.
    if (!term || (term.includes("(") && term.endsWith(")"))) {
      const clearTimer = setTimeout(() => setResults([]), 0);
      return () => clearTimeout(clearTimer);
    }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/products?search=${encodeURIComponent(term)}&perPage=8`);
        if (!res.ok) return;
        const body = (await res.json()) as { products?: PickerProduct[] };
        setResults(body.products ?? []);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [query]);

  const choose = (product: PickerProduct) => {
    onSelect(product);
    setOpen(false);
    setResults([]);
  };

  return (
    <div className="relative">
      <Input
        value={query}
        error={error}
        onChange={(e) => {
          onQueryChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const term = query.trim().toLowerCase();
          const exact = results.find(
            (p) =>
              (p.barcode ?? "").toLowerCase() === term ||
              p.sku.toLowerCase() === term
          );
          const target = exact ?? results[0];
          if (target) choose(target);
        }}
        placeholder="Search or scan name, SKU, barcode…"
      />
      {open && (query.trim().length > 0) && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {loading && <li className="px-3 py-2 text-xs text-slate-400">Searching…</li>}
          {!loading && results.length === 0 && (
            <li className="px-3 py-2 text-xs text-slate-400">No matching product</li>
          )}
          {results.map((p) => (
            <li key={p._id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-slate-900">{p.name}</span>
                  <span className="block text-xs text-slate-400">{p.sku}{p.barcode ? ` · ${p.barcode}` : ""}</span>
                </span>
                <span className="shrink-0 text-xs text-slate-500">
                  {p.costPrice !== undefined ? money(Number(p.costPrice)) : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
