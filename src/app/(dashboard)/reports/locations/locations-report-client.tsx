"use client";

import { useCallback, useEffect, useState } from "react";
import { money } from "@/lib/currency";
import { Table, EmptyState, Button, Input, Select } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";

interface LocationRow {
  productId: string;
  name: string;
  sku: string;
  branchId: string | null;
  branchName: string;
  branchType: string;
  stock: number;
  reorderPoint: number;
  stockValue: number;
}

interface LocationsPayload {
  rows: LocationRow[];
  inTransit: Array<{ branchId: string; branchName: string; units: number }>;
  summary: {
    locations: number;
    products: number;
    totalUnits: number;
    totalValue: number;
    inTransitUnits: number;
    lowStock: number;
    outOfStock: number;
  };
  branches: Array<{ _id: string; name: string; type: string }>;
}

export function LocationsReportClient() {
  const [rows, setRows] = useState<LocationsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [branchId, setBranchId] = useState("");
  const [includeZero, setIncludeZero] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (branchId) params.set("branchId", branchId);
      if (includeZero) params.set("includeZero", "1");
      const res = await fetch(`/api/reports/locations?${params}`);
      const body = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(body, "Failed to load stock by location"));
        return;
      }
      setRows(body as LocationsPayload);
    } catch {
      error("Error", "Failed to load stock by location");
    } finally {
      setLoading(false);
    }
  }, [search, branchId, includeZero]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const columns = [
    {
      key: "product",
      header: "Product",
      render: (row: LocationRow) => (
        <div>
          <div className="font-medium text-slate-900">{row.name}</div>
          {row.sku ? <div className="text-xs text-slate-500">{row.sku}</div> : null}
        </div>
      ),
    },
    {
      key: "location",
      header: "Location",
      render: (row: LocationRow) => (
        <span>
          {row.branchName}
          <span className="ms-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] uppercase text-slate-600">
            {row.branchType}
          </span>
        </span>
      ),
    },
    {
      key: "stock",
      header: "Stock",
      render: (row: LocationRow) => (
        <span className={cn(row.stock <= 0 ? "text-red-600" : row.reorderPoint > 0 && row.stock <= row.reorderPoint ? "text-amber-700" : "text-slate-900")}>
          {row.stock}
        </span>
      ),
    },
    { key: "reorder", header: "Reorder point", render: (row: LocationRow) => row.reorderPoint },
    { key: "value", header: "Stock value", render: (row: LocationRow) => money(row.stockValue) },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Reports", href: "/reports" }, { label: "Stock by location" }]} />
      <PageHeader
        title="Stock by location"
        description="On-hand stock per warehouse/shop, units in transit, low and out-of-stock rows."
        actions={
          <Button variant="secondary" onClick={() => void load()} loading={loading}>
            Refresh
          </Button>
        }
      />

      <div className="mb-4 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, SKU or barcode" />
        <Select
          value={branchId}
          onChange={setBranchId}
          options={[{ value: "", label: "All locations" }, ...(rows?.branches ?? []).map((b) => ({ value: b._id, label: b.name }))]}
        />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
          Include zero-stock rows
        </label>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {[
          { label: "Units", value: String(rows?.summary.totalUnits ?? 0) },
          { label: "Stock value", value: money(rows?.summary.totalValue ?? 0) },
          { label: "In transit", value: String(rows?.summary.inTransitUnits ?? 0) },
          { label: "Low stock", value: String(rows?.summary.lowStock ?? 0) },
          { label: "Out of stock", value: String(rows?.summary.outOfStock ?? 0) },
          { label: "Locations", value: String(rows?.summary.locations ?? 0) },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{card.label}</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{card.value}</p>
          </div>
        ))}
      </div>

      {rows && rows.inTransit.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2 text-sm text-slate-600">
          <span className="font-medium">In transit:</span>
          {rows.inTransit.map((row) => (
            <span key={row.branchId} className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">
              {row.branchName}: {row.units} units
            </span>
          ))}
        </div>
      ) : null}

      <Table
        columns={columns}
        data={rows?.rows ?? []}
        keyExtractor={(row) => `${row.productId}:${row.branchId ?? "none"}`}
        loading={loading}
        empty={<EmptyState label="No stock rows" description="Adjust the filters or receive stock at a location." />}
      />
    </div>
  );
}
