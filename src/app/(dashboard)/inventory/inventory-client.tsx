"use client";

import { useState, useEffect, useCallback } from "react";
import { SessionUser } from "@/lib/session";
import { Table, EmptyState, Button, Modal, SearchInput, DatePicker, FormField, Input, Select } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";
import { money } from "@/lib/currency";
import { Plus, RefreshCw, AlertTriangle } from "@/components/ui/icons";

interface InventoryClientProps {
  user: SessionUser;
}

type MovementType = "PURCHASE_IN" | "SALE_OUT" | "CUSTOMER_RETURN_IN" | "SUPPLIER_RETURN_OUT" | "ADJUSTMENT_IN" | "ADJUSTMENT_OUT" | "STOCK_COUNT_IN" | "STOCK_COUNT_OUT";

type MovementRow = {
  _id: string;
  createdAt: string;
  productName?: string | null;
  sku?: string | null;
  movementType: string;
  quantity: number;
  unitCost: number;
  reason?: string | null;
  note?: string | null;
};

const MOVEMENT_LABELS: Record<MovementType, string> = {
  PURCHASE_IN: "Purchase In",
  SALE_OUT: "Sale Out",
  CUSTOMER_RETURN_IN: "Customer Return In",
  SUPPLIER_RETURN_OUT: "Supplier Return Out",
  ADJUSTMENT_IN: "Adjustment In",
  ADJUSTMENT_OUT: "Adjustment Out",
  STOCK_COUNT_IN: "Stock Count In",
  STOCK_COUNT_OUT: "Stock Count Out",
};

export function InventoryClient({ user }: InventoryClientProps) {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<Array<{
    _id: string;
    name: string;
    sku: string;
    currentStock: number;
    reorderPoint: number;
    status: string;
    categoryId: { _id: string; name: string } | null;
    brandId: { _id: string; name: string } | null;
  }>>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage] = useState(15);
  const [productFilter, setProductFilter] = useState("");
  const [movementTypeFilter, setMovementTypeFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [adjustProduct, setAdjustProduct] = useState<typeof products[0] | null>(null);
  const [adjustForm, setAdjustForm] = useState({ quantity: "", type: "ADJUSTMENT_IN" as MovementType, reason: "" });
  const [adjustErrors, setAdjustErrors] = useState<Record<string, string>>({});
  const [adjusting, setAdjusting] = useState(false);
  const [stats, setStats] = useState({ totalProducts: 0, lowStock: 0, outOfStock: 0 });

  const loadInventory = useCallback(async (reloadFilters = false) => {
    if (reloadFilters) {
      // filters already set
    }

    try {
      const params = new URLSearchParams({
        page: String(page),
        perPage: String(perPage),
        product: productFilter,
        type: movementTypeFilter,
        from: fromDate,
        to: toDate,
      });
      const res = await fetch(`/api/inventory?${params}`);
      if (!res.ok) throw new Error("Failed to load inventory");
      const data = await res.json();
      setProducts(data.products ?? []);
      setMovements(data.movements ?? []);
      setTotal(data.total ?? 0);
      setStats(data.stats ?? { totalProducts: 0, lowStock: 0, outOfStock: 0 });
    } catch {
      error("Error", "Failed to load inventory");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, productFilter, movementTypeFilter, fromDate, toDate]);

  useEffect(() => {
    void (async () => {
      await loadInventory(true);
    })();
  }, [loadInventory]);

  const openAdjustment = (product?: typeof products[0]) => {
    setAdjustProduct(product ?? null);
    setAdjustForm({ quantity: "", type: "ADJUSTMENT_IN", reason: "" });
    setAdjustErrors({});
    setAdjustModalOpen(true);
  };

  const validateAdjustment = (): boolean => {
    const errs: Record<string, string> = {};
    const qty = Number(adjustForm.quantity);
    if (!adjustForm.quantity || isNaN(qty) || qty <= 0) errs.quantity = "Enter a positive quantity";
    if (!adjustForm.reason.trim()) errs.reason = "Reason is required";
    setAdjustErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleAdjust = async () => {
    if (!validateAdjustment()) return;
    setAdjusting(true);
    try {
      const payload = {
        productId: adjustProduct?._id ?? "",
        branchId: null, // placeholder; use user branch if available
        quantity: Number(adjustForm.quantity),
        movementType: adjustForm.type,
        referenceType: "adjustment",
        referenceId: null,
        unitCost: 0,
        reason: adjustForm.reason.trim(),
        userId: user.id,
      };
      const res = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to adjust stock"));
        return;
      }
      success("Success", "Stock adjusted");
      setAdjustModalOpen(false);
      loadInventory();
    } catch {
      error("Error", "Failed to adjust stock");
    } finally {
      setAdjusting(false);
    }
  };

  const statsCards = (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <p className="text-sm font-medium text-slate-500">Total Products</p>
        <p className="mt-1 text-2xl font-semibold text-slate-900">{stats.totalProducts}</p>
      </div>
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-amber-700">Low Stock</p>
          <AlertTriangle className="h-5 w-5 text-amber-500" />
        </div>
        <p className="mt-1 text-2xl font-semibold text-amber-800">{stats.lowStock}</p>
      </div>
      <div className="rounded-xl border border-red-200 bg-red-50 p-5">
        <p className="text-sm font-medium text-red-700">Out of Stock</p>
        <p className="mt-1 text-2xl font-semibold text-red-800">{stats.outOfStock}</p>
      </div>
    </div>
  );

  const productOptions = products.map((p) => ({ value: p._id, label: `${p.name} (${p.sku})` }));
  const movementTypeOptions = Object.entries(MOVEMENT_LABELS).map(([v, l]) => ({ value: v, label: l }));

  const movementColumns = [
    {
      key: "createdAt",
      header: "Date",
      render: (row: MovementRow) => new Date(row.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    },
    {
      key: "product",
      header: "Product",
      render: (row: MovementRow) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-900">{row.productName ?? "—"}</span>
          <span className="text-xs text-slate-400">{row.sku ?? ""}</span>
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      render: (row: MovementRow) => (
        <span className={cn(
          "rounded-full px-2 py-0.5 text-xs font-medium",
          row.movementType?.includes("IN") ? "bg-green-100 text-green-700" : row.movementType?.includes("OUT") ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"
        )}>
          {MOVEMENT_LABELS[row.movementType as MovementType] ?? row.movementType}
        </span>
      ),
    },
    {
      key: "quantity",
      header: "Qty",
      render: (row: MovementRow) => (
        <span className={cn("font-medium", row.quantity > 0 ? "text-green-600" : "text-red-600")}>
          {row.quantity > 0 ? "+" : ""}{row.quantity}
        </span>
      ),
    },
    {
      key: "unitCost",
      header: "Unit Cost",
      render: (row: MovementRow) => money(Number(row.unitCost ?? 0)),
    },
    {
      key: "reason",
      header: "Reason",
      render: (row: MovementRow) => row.reason ?? row.note ?? "—",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Inventory" }]} />
      <PageHeader
        title="Inventory"
        description="Stock levels and movement history"
        actions={
          <Button variant="secondary" onClick={() => loadInventory()} loading={loading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {statsCards}

      <div className="mt-6">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Stock Movement History</h2>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px]">
            <SearchInput
              value={productFilter}
              onChange={setProductFilter}
              onSearch={() => setPage(1)}
              placeholder="Filter by product name or SKU..."
              className="max-w-sm"
            />
          </div>
          <div className="w-40">
            <Select
              value={movementTypeFilter}
              onChange={(v) => { setMovementTypeFilter(v); setPage(1); }}
              options={[{ value: "", label: "All movement types" }, ...movementTypeOptions]}
              className="w-full"
            />
          </div>
          <div className="w-32">
            <DatePicker label="From" value={fromDate} onChange={setFromDate} />
          </div>
          <div className="w-32">
            <DatePicker label="To" value={toDate} onChange={setToDate} />
          </div>
          {(productFilter || movementTypeFilter || fromDate || toDate) && (
            <Button variant="ghost" onClick={() => { setProductFilter(""); setMovementTypeFilter(""); setFromDate(""); setToDate(""); setPage(1); }}>
              Clear filters
            </Button>
          )}
        </div>

        <Table
          columns={movementColumns}
          data={movements}
          keyExtractor={(row) => row._id.toString()}
          loading={loading}
          empty={
            <EmptyState
              label="No movements"
              description="Stock movements will appear here when inventory changes occur."
            />
          }
        />
      </div>

      {/* Stock overview table */}
      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Stock Overview</h2>
        <Table
          columns={[
            {
              key: "name",
              header: "Product",
              render: (row: typeof products[0]) => (
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-sm">
                    {row.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">{row.name}</p>
                    <p className="text-xs text-slate-500">{row.sku}</p>
                    <p className="text-xs text-slate-400">{row.categoryId?.name ?? ""}</p>
                  </div>
                </div>
              ),
            },
            {
              key: "stock",
              header: "Current Stock",
              render: (row: typeof products[0]) => {
                const s = row.currentStock ?? 0;
                return (
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "font-semibold",
                      s === 0 ? "text-red-600" : s <= (row.reorderPoint ?? 0) ? "text-amber-600" : "text-slate-900"
                    )}>
                      {s}
                    </span>
                    {s <= (row.reorderPoint ?? 0) && s > 0 && (
                      <span className="text-xs text-amber-600">Low</span>
                    )}
                    {s === 0 && <span className="text-xs text-red-600">Out of stock</span>}
                  </div>
                );
              },
            },
            {
              key: "min",
              header: "Min Stock",
              render: (row: typeof products[0]) => String(row.reorderPoint ?? 0),
            },
            {
              key: "actions",
              header: "",
              className: "w-24",
              render: (_row: typeof products[0]) => (
                <Button size="sm" variant="secondary" onClick={() => openAdjustment(_row)}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Adjust
                </Button>
              ),
            },
          ]}
          data={products}
          keyExtractor={(row) => row._id}
          loading={loading}
          empty={
            <EmptyState
              label="No products in stock"
              description="Products will appear here once added."
            />
          }
        />
      </div>

      <Modal
        open={adjustModalOpen}
        onClose={() => setAdjustModalOpen(false)}
        title="Stock Adjustment"
        size="sm"
        footer={
          [
            <Button key="cancel" variant="secondary" onClick={() => setAdjustModalOpen(false)}>Cancel</Button>,
            <Button key="save" variant="primary" loading={adjusting} onClick={handleAdjust}>
              {adjustForm.type === "ADJUSTMENT_IN" ? "Add Stock" : "Remove Stock"}
            </Button>,
          ]
        }
      >
        <div className="space-y-4">
          <FormField label="Product">
            <Select
              value={adjustProduct?._id ?? ""}
              onChange={(v) => {
                const found = products.find((p) => p._id === v);
                setAdjustProduct(found ?? null);
              }}
              options={productOptions}
              placeholder="Select product"
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Type">
              <Select
                value={adjustForm.type}
                onChange={(v) => setAdjustForm({ ...adjustForm, type: v as MovementType })}
                options={movementTypeOptions.filter((o) => o.value.startsWith("ADJUSTMENT") || o.value.startsWith("STOCK_COUNT"))}
              />
            </FormField>
            <FormField label="Quantity" required error={adjustErrors.quantity}>
              <Input
                type="number"
                min="1"
                step="1"
                value={adjustForm.quantity}
                onChange={(e) => setAdjustForm({ ...adjustForm, quantity: e.target.value })}
                placeholder="0"
              />
            </FormField>
          </div>
          <FormField label="Reason" required error={adjustErrors.reason}>
            <Input
              value={adjustForm.reason}
              onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })}
              placeholder="e.g. Damaged, Counted, Correction"
            />
          </FormField>
        </div>
      </Modal>
    </div>
  );
}
