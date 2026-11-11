"use client";

import { useState, useEffect, useCallback } from "react";
import { SessionUser } from "@/lib/session";
import { Table, EmptyState, Button, Modal, SearchInput, DatePicker, FormField, Input, Select, Pagination } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";
import { money } from "@/lib/currency";
import { Plus, RefreshCw, AlertTriangle, X } from "@/components/ui/icons";

interface InventoryClientProps {
  user: SessionUser;
  /** Pre-applied expiry filter from a dashboard notification link. */
  initialExpiry?: string;
}

type MovementType = "PURCHASE_IN" | "SALE_OUT" | "CUSTOMER_RETURN_IN" | "SUPPLIER_RETURN_OUT" | "ADJUSTMENT_IN" | "ADJUSTMENT_OUT" | "STOCK_COUNT_IN" | "STOCK_COUNT_OUT" | "TRANSFER_IN" | "TRANSFER_OUT";

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
  locationName?: string | null;
};

type StockLocation = { _id: string; name: string; type: string; status: string };

type LocationStock = {
  id?: string;
  branchId: string | null;
  warehouseId?: string | null;
  name: string;
  type?: string;
  quantity: number;
};

type StockRow = {
  _id: string;
  name: string;
  sku: string;
  barcode?: string;
  currentStock: number;
  reorderPoint: number;
  sellingPrice?: number;
  expiredQty?: number;
  expiringQty?: number;
  earliestExpiration?: string | null;
  expirationDate?: string | null;
  status: string;
  categoryId: { _id: string; name: string } | null;
  brandId: { _id: string; name: string } | null;
  /** Quantity on hand in each location (shop and warehouse). */
  stockByLocation?: LocationStock[];
};

type StockStatusFilter = "" | "low" | "out";
type ExpiryFilter = "" | "expired" | "expiring" | "all";

const MOVEMENT_LABELS: Record<MovementType, string> = {
  PURCHASE_IN: "Purchase In",
  SALE_OUT: "Sale Out",
  CUSTOMER_RETURN_IN: "Customer Return In",
  TRANSFER_IN: "Transfer In",
  TRANSFER_OUT: "Transfer Out",
  SUPPLIER_RETURN_OUT: "Supplier Return Out",
  ADJUSTMENT_IN: "Adjustment In",
  ADJUSTMENT_OUT: "Adjustment Out",
  STOCK_COUNT_IN: "Stock Count In",
  STOCK_COUNT_OUT: "Stock Count Out",
};

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function InventoryClient({ user, initialExpiry = "" }: InventoryClientProps) {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<StockRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage] = useState(15);
  const [productPage, setProductPage] = useState(1);
  const [productPerPage] = useState(15);
  const [productTotal, setProductTotal] = useState(0);
  const [productTotalPages, setProductTotalPages] = useState(1);
  const [productFilter, setProductFilter] = useState("");
  const [movementTypeFilter, setMovementTypeFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [stockStatus, setStockStatus] = useState<StockStatusFilter>("");
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>(
    initialExpiry === "expired" || initialExpiry === "expiring" || initialExpiry === "all"
      ? initialExpiry
      : ""
  );
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [adjustProduct, setAdjustProduct] = useState<StockRow | null>(null);
  const [adjustForm, setAdjustForm] = useState({ quantity: "", type: "ADJUSTMENT_IN" as MovementType, reason: "", locationId: "" });
  const [adjustErrors, setAdjustErrors] = useState<Record<string, string>>({});
  const [adjusting, setAdjusting] = useState(false);
  const [stats, setStats] = useState({
    totalProducts: 0,
    lowStock: 0,
    outOfStock: 0,
    expired: 0,
    expiring: 0,
    shopUnits: 0,
    warehouseUnits: 0,
  });
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [locationFilter, setLocationFilter] = useState("");

  const loadInventory = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        page: String(page),
        perPage: String(perPage),
        productPage: String(productPage),
        productPerPage: String(productPerPage),
        product: productFilter,
        location: locationFilter,
        stockStatus,
        expiry: expiryFilter,
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
      setProductTotal(data.productTotal ?? 0);
      setProductTotalPages(data.productTotalPages ?? 1);
      setStats(
        data.stats ?? {
          totalProducts: 0,
          lowStock: 0,
          outOfStock: 0,
          expired: 0,
          expiring: 0,
          shopUnits: 0,
          warehouseUnits: 0,
        }
      );
      setLocations(data.locations ?? []);
    } catch {
      error("Error", "Failed to load inventory");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, productPage, productPerPage, productFilter, locationFilter, stockStatus, expiryFilter, movementTypeFilter, fromDate, toDate]);

  useEffect(() => {
    void (async () => {
      await loadInventory();
    })();
  }, [loadInventory]);

  const hasStockFilter = stockStatus !== "" || expiryFilter !== "";

  const toggleStockStatus = (next: StockStatusFilter) => {
    setStockStatus((current) => (current === next ? "" : next));
    setProductPage(1);
  };

  const toggleExpiry = (next: ExpiryFilter) => {
    setExpiryFilter((current) => (current === next ? "" : next));
    setProductPage(1);
  };

  const clearStockFilters = () => {
    setStockStatus("");
    setExpiryFilter("");
    setProductPage(1);
  };

  const openAdjustment = (product?: StockRow) => {
    setAdjustProduct(product ?? null);
    setAdjustForm({
      quantity: "",
      type: "ADJUSTMENT_IN",
      reason: "",
      locationId:
        locationFilter || product?.stockByLocation?.[0]?.branchId || user.branchId || "",
    });
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
        branchId: adjustForm.locationId || null,
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

  // Clickable KPI cards — the low/out and expiry indicators are the filters.
  const statsCards = (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
      <button
        type="button"
        onClick={clearStockFilters}
        className={cn(
          "rounded-xl border bg-white p-4 text-left transition hover:border-slate-300 hover:shadow-sm",
          !hasStockFilter ? "border-slate-400 ring-2 ring-slate-200" : "border-slate-200"
        )}
      >
        <p className="text-sm font-medium text-slate-500">Total Products</p>
        <p className="mt-1 text-2xl font-semibold text-slate-900">{stats.totalProducts}</p>
        <p className="mt-1 text-xs text-slate-400">Show all products</p>
      </button>
      <button
        type="button"
        onClick={() => toggleStockStatus("low")}
        className={cn(
          "rounded-xl border bg-amber-50 p-4 text-left transition hover:border-amber-400 hover:shadow-sm",
          stockStatus === "low" ? "border-amber-500 ring-2 ring-amber-200" : "border-amber-200"
        )}
        aria-pressed={stockStatus === "low"}
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-amber-700">Low Stock</p>
          <AlertTriangle className="h-5 w-5 text-amber-500" />
        </div>
        <p className="mt-1 text-2xl font-semibold text-amber-800">{stats.lowStock}</p>
        <p className="mt-1 text-xs text-amber-600">{stockStatus === "low" ? "Filter active — click to clear" : "Click to filter"}</p>
      </button>
      <button
        type="button"
        onClick={() => toggleStockStatus("out")}
        className={cn(
          "rounded-xl border bg-red-50 p-4 text-left transition hover:border-red-400 hover:shadow-sm",
          stockStatus === "out" ? "border-red-500 ring-2 ring-red-200" : "border-red-200"
        )}
        aria-pressed={stockStatus === "out"}
      >
        <p className="text-sm font-medium text-red-700">Out of Stock</p>
        <p className="mt-1 text-2xl font-semibold text-red-800">{stats.outOfStock}</p>
        <p className="mt-1 text-xs text-red-500">{stockStatus === "out" ? "Filter active — click to clear" : "Click to filter"}</p>
      </button>
      <button
        type="button"
        onClick={() => toggleExpiry("expired")}
        className={cn(
          "rounded-xl border bg-rose-50 p-4 text-left transition hover:border-rose-400 hover:shadow-sm",
          expiryFilter === "expired" ? "border-rose-500 ring-2 ring-rose-200" : "border-rose-200"
        )}
        aria-pressed={expiryFilter === "expired"}
      >
        <p className="text-sm font-medium text-rose-700">Expired</p>
        <p className="mt-1 text-2xl font-semibold text-rose-800">{stats.expired}</p>
        <p className="mt-1 text-xs text-rose-500">{expiryFilter === "expired" ? "Filter active — click to clear" : "Click to filter"}</p>
      </button>
      <button
        type="button"
        onClick={() => toggleExpiry("expiring")}
        className={cn(
          "rounded-xl border bg-orange-50 p-4 text-left transition hover:border-orange-400 hover:shadow-sm",
          expiryFilter === "expiring" ? "border-orange-500 ring-2 ring-orange-200" : "border-orange-200"
        )}
        aria-pressed={expiryFilter === "expiring"}
      >
        <p className="text-sm font-medium text-orange-700">Expiring ≤ 30 days</p>
        <p className="mt-1 text-2xl font-semibold text-orange-800">{stats.expiring}</p>
        <p className="mt-1 text-xs text-orange-500">{expiryFilter === "expiring" ? "Filter active — click to clear" : "Click to filter"}</p>
      </button>
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
      key: "location",
      header: "Location",
      render: (row: MovementRow) =>
        row.locationName ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            {row.locationName}
          </span>
        ) : (
          "—"
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
    { key: "unitCost", header: "Unit Cost", render: (row: MovementRow) => money(Number(row.unitCost ?? 0)) },
    { key: "reason", header: "Reason", render: (row: MovementRow) => row.reason ?? row.note ?? "—" },
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

      {hasStockFilter && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-500">Showing:</span>
          {stockStatus && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white">
              {stockStatus === "low" ? "Low stock" : "Out of stock"}
              <button onClick={() => toggleStockStatus(stockStatus)} aria-label="Clear stock filter">
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
          {expiryFilter && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white">
              {expiryFilter === "expired"
                ? "Expired batches"
                : expiryFilter === "expiring"
                  ? "Expiring within 30 days"
                  : "Expired or expiring within 30 days"}
              <button onClick={() => toggleExpiry(expiryFilter)} aria-label="Clear expiry filter">
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={clearStockFilters}>
            Clear filter
          </Button>
        </div>
      )}

      <div className="mt-6">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Stock Movement History</h2>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px]">
            <SearchInput
              value={productFilter}
              onChange={(v) => {
                setProductFilter(v);
                setProductPage(1);
              }}
              onSearch={() => {
                setProductPage(1);
                setPage(1);
              }}
              placeholder="Filter by product name, SKU or barcode..."
              className="max-w-sm"
            />
          </div>
          <div className="w-44">
            <Select
              value={locationFilter}
              onChange={(v) => { setLocationFilter(v); setPage(1); setProductPage(1); }}
              options={[
                { value: "", label: "All locations" },
                ...locations.map((l) => ({
                  value: l._id,
                  label: `${l.name}${l.type === "warehouse" ? " (warehouse)" : ""}`,
                })),
              ]}
              className="w-full"
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
          {(productFilter || movementTypeFilter || locationFilter || fromDate || toDate) && (
            <Button variant="ghost" onClick={() => { setProductFilter(""); setMovementTypeFilter(""); setLocationFilter(""); setFromDate(""); setToDate(""); setPage(1); setProductPage(1); }}>
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
        {total > perPage && (
          <div className="mt-4">
            <Pagination page={page} totalPages={Math.ceil(total / perPage)} totalItems={total} itemsPerPage={perPage} onPageChange={setPage} />
          </div>
        )}
      </div>

      {/* Stock overview table */}
      <div className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Stock Overview</h2>
          <span className="text-sm text-slate-500">
            {productTotal} product{productTotal === 1 ? "" : "s"} · {stats.shopUnits} units in shop ·{" "}
            {stats.warehouseUnits} units in warehouse
          </span>
        </div>
        <Table
          columns={[
            {
              key: "name",
              header: "Product",
              render: (row: StockRow) => (
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-sm">
                    {row.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">{row.name}</p>
                    <p className="text-xs text-slate-500">{row.sku}{row.barcode ? ` · ${row.barcode}` : ""}</p>
                    <p className="text-xs text-slate-400">{row.categoryId?.name ?? ""}</p>
                  </div>
                </div>
              ),
            },
            {
              key: "stock",
              header: "Current Stock",
              render: (row: StockRow) => {
                const s = row.currentStock ?? 0;
                const expired = row.expiredQty ?? 0;
                return (
                  <div className="flex flex-col gap-1">
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
                      {s <= 0 && <span className="text-xs text-red-600">Out of stock</span>}
                    </div>
                    {expired > 0 && (
                      <span className="w-fit rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                        {expired} expired
                      </span>
                    )}
                  </div>
                );
              },
            },
            {
              key: "shopStock",
              header: "In Shop",
              render: (row: StockRow) => {
                // Only shop stock is sellable at the POS; warehouse units are
                // reserve and stay out of the till until they are transferred.
                const shop = (row.stockByLocation ?? [])
                  .filter((l) => l.type !== "warehouse")
                  .reduce((sum, l) => sum + (l.quantity ?? 0), 0);
                return (
                  <span className={cn("font-semibold", shop <= 0 ? "text-slate-400" : "text-slate-900")}>{shop}</span>
                );
              },
            },
            {
              key: "warehouseStock",
              header: "In Warehouse",
              render: (row: StockRow) => {
                const warehouse = (row.stockByLocation ?? [])
                  .filter((l) => l.type === "warehouse")
                  .reduce((sum, l) => sum + (l.quantity ?? 0), 0);
                return (
                  <span className={cn("font-semibold", warehouse <= 0 ? "text-slate-400" : "text-indigo-700")}>
                    {warehouse}
                  </span>
                );
              },
            },
            {
              key: "locations",
              header: "Stock by Location",
              render: (row: StockRow) => {
                const rows = (row.stockByLocation ?? []).filter(
                  (l) => l.branchId !== null || l.quantity !== 0
                );
                if (rows.length === 0) return <span className="text-xs text-slate-400">—</span>;
                return (
                  <div className="flex flex-wrap gap-1">
                    {rows.map((l) => (
                      <span
                        key={l.id ?? l.branchId ?? l.name}
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          l.type === "warehouse" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-700"
                        )}
                      >
                        {l.name}: <span className="font-semibold">{l.quantity}</span>
                      </span>
                    ))}
                  </div>
                );
              },
            },
            { key: "min", header: "Min Stock", render: (row: StockRow) => String(row.reorderPoint ?? 0) },
            {
              key: "expiry",
              header: "Expiry",
              render: (row: StockRow) => {
                const date = row.earliestExpiration ?? row.expirationDate ?? null;
                if (!date) return <span className="text-xs text-slate-400">No expiry</span>;
                const days = Math.ceil((new Date(date).getTime() - Date.now()) / 86_400_000);
                const expired = (row.expiredQty ?? 0) > 0 || days < 0;
                const expiring = !expired && ((row.expiringQty ?? 0) > 0 || days <= 30);
                return (
                  <div className="flex flex-col gap-1">
                    <span className="text-sm text-slate-700">{formatDate(date)}</span>
                    <span className={cn(
                      "w-fit rounded-full px-2 py-0.5 text-[11px] font-medium",
                      expired ? "bg-rose-100 text-rose-700" : expiring ? "bg-orange-100 text-orange-700" : "bg-emerald-100 text-emerald-700"
                    )}>
                      {expired ? "Expired" : expiring ? `Expires in ${Math.max(0, days)}d` : "OK"}
                    </span>
                  </div>
                );
              },
            },
            {
              key: "actions",
              header: "",
              className: "w-24",
              render: (row: StockRow) => (
                <Button size="sm" variant="secondary" onClick={() => openAdjustment(row)}>
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
              label={hasStockFilter ? "No products match this filter" : "No products in stock"}
              description={hasStockFilter ? "Clear the filter to see the complete inventory list." : "Products will appear here once added."}
            />
          }
        />
        {productTotalPages > 1 && (
          <div className="mt-4">
            <Pagination
              page={productPage}
              totalPages={productTotalPages}
              totalItems={productTotal}
              itemsPerPage={productPerPage}
              onPageChange={setProductPage}
            />
          </div>
        )}
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
          <FormField label="Location" hint="Adjustments are recorded against a shop; move stock to a warehouse with a transfer instead.">
            <Select
              value={adjustForm.locationId}
              onChange={(v) => setAdjustForm({ ...adjustForm, locationId: v })}
              options={locations
                .filter((l) => !l._id.startsWith("warehouse:"))
                .map((l) => ({
                  value: l._id,
                  label: l.name,
                }))}
              placeholder="Select location"
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
