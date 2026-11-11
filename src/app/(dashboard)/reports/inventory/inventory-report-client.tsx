"use client";

import { ReportShell, money } from "@/components/report-shell";

interface StockRow {
  _id: string;
  name: string;
  sku: string;
  stock: number;
  /** Units on hand in the shop(s). */
  shopStock: number;
  /** Units on hand in warehouses. */
  warehouseStock: number;
  /** Unit price paid on the most recent purchase receipt. */
  unitPrice: number;
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
      description="Stock levels in the shop and the warehouse, valuation and movements"
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
        { key: "stock", header: "Total Stock", align: "right", render: (r) => {
          const m = r as MovementRow;
          if (isMovement(String(m.movementType ?? ""))) {
            return <span className={m.quantity < 0 ? "text-red-600" : "text-green-700"}>{m.quantity > 0 ? "+" : ""}{m.quantity}</span>;
          }
          const s = r as StockRow;
          return <span className={s.stock <= 0 ? "font-semibold text-red-600" : s.stock <= s.reorderPoint ? "font-semibold text-amber-600" : ""}>{s.stock}</span>;
        } },
        { key: "shopStock", header: "In Shop", align: "right", render: (r) => {
          // Only shop stock can be sold from the POS; warehouse units are reserve.
          return isMovement(String((r as MovementRow).movementType ?? "")) ? "—" : String((r as StockRow).shopStock ?? 0);
        } },
        { key: "warehouseStock", header: "In Warehouse", align: "right", render: (r) => {
          return isMovement(String((r as MovementRow).movementType ?? "")) ? "—" : String((r as StockRow).warehouseStock ?? 0);
        } },
        { key: "unitPrice", header: "Unit Price (purchase)", align: "right", render: (r) => {
          if (isMovement(String((r as MovementRow).movementType ?? ""))) {
            return money((r as MovementRow).unitCost ?? 0);
          }
          return money((r as StockRow).unitPrice ?? 0);
        } },
        { key: "sellingPrice", header: "Unit Selling Price", align: "right", render: (r) => {
          const s = r as StockRow;
          // Variants are separate product rows, so this is always the actual
          // single-piece price for that sellable product.
          return !isMovement(String((r as MovementRow).movementType ?? "")) ? money(s.sellingPrice ?? 0) : "—";
        } },
        { key: "value", header: "Value", align: "right", render: (r) => {
          const s = r as StockRow;
          return !isMovement(String((r as MovementRow).movementType ?? "")) ? money(s.value) : "—";
        } },
        { key: "createdAt", header: "Date", render: (r) => {
          const m = r as MovementRow;
          return isMovement(String(m.movementType ?? ""))
            ? new Date(m.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
            : "—";
        } },
        { key: "userName", header: "By", render: (r) => (r as MovementRow).userName ?? "—" },
      ]}
    />
  );
}
