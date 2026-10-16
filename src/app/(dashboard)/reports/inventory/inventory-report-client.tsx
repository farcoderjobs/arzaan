"use client";

import { ReportShell, money } from "@/components/report-shell";

interface StockRow {
  _id: string;
  name: string;
  sku: string;
  stock: number;
  reorderPoint: number;
  costPrice: number;
  sellingPrice: number;
  value: number;
  retailValue: number;
}

interface MovementRow {
  _id: string;
  createdAt: string;
  movementType: string;
  quantity: number;
  unitCost: number;
  note: string;
  productName: string;
  sku: string;
  userName: string;
}

const isMovement = (view: string) => view === "movements" || view === "adjustments";

const VIEWS = [
  { value: "stock", label: "Current stock" },
  { value: "low", label: "Low stock" },
  { value: "out", label: "Out of stock" },
  { value: "valuation", label: "Inventory valuation" },
  { value: "movements", label: "Stock movements" },
  { value: "adjustments", label: "Adjustments" },
];

export function InventoryReportClient() {
  return (
    <ReportShell<StockRow | MovementRow>
      title="Inventory Report"
      description="Stock levels, valuation, movements and adjustments"
      endpoint="/api/reports/inventory"
      viewParam="view"
      defaultView="stock"
      views={VIEWS}
      summary={(data) => {
        const view = String(data.view ?? "stock");
        const s = (data.summary ?? {}) as Record<string, number>;
        if (view === "valuation" && s.totalValue !== undefined) {
          return [
            { label: "Stock value (cost)", value: money(s.totalValue), tone: "blue" },
            { label: "Products listed", value: String(data.total ?? 0) },
          ];
        }
        if (view === "movements") {
          return [{ label: "Net units moved", value: String(s.units ?? 0) }];
        }
        return [];
      }}
      rows={(data) => ((data.rows ?? []) as unknown as Array<StockRow & MovementRow>)}
      rowKey={(r) => r._id}
      columns={[
        { key: "name", header: "Product", render: (r) => {
          const row = r as StockRow & MovementRow;
          if (isMovement(String((r as MovementRow).movementType ?? ""))) {
            const m = r as MovementRow;
            return (
              <div>
                <p className="font-medium text-slate-900">{m.productName}</p>
                <p className="text-xs text-slate-400">{m.sku} · {m.movementType}</p>
              </div>
            );
          }
          return (
            <div>
              <p className="font-medium text-slate-900">{row.name}</p>
              <p className="text-xs text-slate-400">{row.sku}</p>
            </div>
          );
        } },
        { key: "stock", header: "Stock", align: "right", render: (r) => {
          const m = r as MovementRow;
          if (isMovement(String(m.movementType ?? ""))) {
            return <span className={m.quantity < 0 ? "text-red-600" : "text-green-700"}>{m.quantity > 0 ? "+" : ""}{m.quantity}</span>;
          }
          const s = r as StockRow;
          return <span className={s.stock <= 0 ? "font-semibold text-red-600" : s.stock <= s.reorderPoint ? "font-semibold text-amber-600" : ""}>{s.stock}</span>;
        } },
        { key: "createdAt", header: "Date", render: (r) => {
          const m = r as MovementRow;
          return isMovement(String(m.movementType ?? ""))
            ? new Date(m.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
            : "—";
        } },
        { key: "note", header: "Note", render: (r) => {
          const m = r as MovementRow;
          return isMovement(String(m.movementType ?? "")) ? (m.note || "—") : "—";
        } },
        { key: "userName", header: "By", render: (r) => (r as MovementRow).userName ?? "—" },
        { key: "value", header: "Value", align: "right", render: (r) => {
          const s = r as StockRow;
          return !isMovement(String((r as MovementRow).movementType ?? "")) ? money(s.value) : "—";
        } },
      ]}
    />
  );
}
