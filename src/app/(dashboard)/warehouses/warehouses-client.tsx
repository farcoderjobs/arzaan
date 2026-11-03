"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, EmptyState, Input, Table } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { money } from "@/lib/currency";
import { error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";

interface WarehouseOption {
  _id: string;
  name: string;
  code: string;
  status: "active" | "inactive";
  itemCount: number;
  units: number;
  stockValue: number;
}

interface InventoryItem {
  productId: string;
  name: string;
  sku: string;
  barcode: string;
  variantName: string;
  quantity: number;
  unitCost: number;
  value: number;
}

/**
 * Warehouse stock view. Warehouses are standalone locations, so this page only
 * reads their inventory — items move in and out through stock transfers.
 */
export function WarehousesClient() {
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [selected, setSelected] = useState("");
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);

  const loadWarehouses = useCallback(async () => {
    try {
      const res = await fetch("/api/warehouses");
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to load warehouses"));
        return;
      }
      const list = (data.warehouses ?? []) as WarehouseOption[];
      setWarehouses(list);
      setSelected((current) => current || list[0]?._id || "");
    } catch {
      error("Error", "Failed to load warehouses");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadWarehouses();
    })();
  }, [loadWarehouses]);

  const loadItems = useCallback(async () => {
    if (!selected) {
      setItems([]);
      return;
    }
    setLoadingItems(true);
    try {
      const params = new URLSearchParams({ warehouseId: selected });
      if (search) params.set("search", search);
      const res = await fetch(`/api/warehouses/inventory?${params}`);
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to load warehouse stock"));
        return;
      }
      setItems(data.items ?? []);
    } catch {
      error("Error", "Failed to load warehouse stock");
    } finally {
      setLoadingItems(false);
    }
  }, [selected, search]);

  useEffect(() => {
    void (async () => {
      await loadItems();
    })();
  }, [loadItems]);

  const current = warehouses.find((w) => w._id === selected) ?? null;

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Warehouses" }]} />
      <PageHeader
        title="Warehouses"
        description="Stock held outside the shops. Move items between a shop and a warehouse from Stock transfers."
        actions={
          <Link href="/transfers">
            <Button variant="secondary">Move stock</Button>
          </Link>
        }
      />

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : warehouses.length === 0 ? (
        <EmptyState
          label="No warehouses yet"
          description="Add one from Settings → Warehouses, then move stock there with a transfer."
        />
      ) : (
        <>
          <div className="no-scrollbar mb-4 flex gap-2 overflow-x-auto">
            {warehouses.map((w) => (
              <button
                key={w._id}
                onClick={() => setSelected(w._id)}
                className={cn(
                  "shrink-0 rounded-xl border px-4 py-3 text-left transition",
                  w._id === selected
                    ? "border-blue-500 bg-blue-50"
                    : "border-slate-200 bg-white hover:bg-slate-50"
                )}
              >
                <p className="text-sm font-semibold text-slate-900">{w.name}</p>
                <p className="text-xs text-slate-500">
                  {w.units} units · {w.itemCount} items
                </p>
              </button>
            ))}
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Items</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{current?.itemCount ?? 0}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Units</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{current?.units ?? 0}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Stock value</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{money(current?.stockValue ?? 0)}</p>
            </div>
          </div>

          <div className="mb-4 max-w-xs">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, SKU or barcode…"
            />
          </div>

          <Table
            columns={[
              {
                key: "name",
                header: "Product",
                render: (row: InventoryItem) => (
                  <div>
                    <p className="font-medium text-slate-900">{row.name}</p>
                    <p className="text-xs text-slate-500">
                      {row.sku || "—"}
                      {row.variantName ? ` · ${row.variantName}` : ""}
                      {row.barcode ? ` · ${row.barcode}` : ""}
                    </p>
                  </div>
                ),
              },
              { key: "quantity", header: "Quantity", render: (row: InventoryItem) => row.quantity },
              { key: "cost", header: "Unit cost", render: (row: InventoryItem) => money(row.unitCost) },
              { key: "value", header: "Value", render: (row: InventoryItem) => money(row.value) },
            ]}
            data={items}
            keyExtractor={(row) => row.productId}
            loading={loadingItems}
            empty={<EmptyState label="No stock here" description="Transfer items from a shop to fill this warehouse." />}
          />
        </>
      )}
    </div>
  );
}
