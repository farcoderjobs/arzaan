import mongoose from "mongoose";
import { InventoryMovement, Product } from "@/models";
import {
  EXPIRING_WINDOW_DAYS,
  addDays,
  batchStockStages,
  classifyExpiration,
  daysUntil,
  STOCK_IN_TYPES,
} from "@/lib/expiry";

/**
 * Expiration alerts for the dashboard.
 *
 * Two sources are merged:
 *  1. Dated purchase batches (inventory movements grouped by batch).
 *  2. Products with a product-level `expirationDate` but no dated batches.
 *
 * Expired stock is reported, never deleted or excluded from stock totals.
 */

export type ExpiryAlertItem = {
  productId: string;
  name: string;
  sku: string;
  barcode: string;
  batchNumber: string;
  quantity: number;
  expirationDate: string;
  daysRemaining: number;
  status: "expired" | "expiring";
};

export type ExpiryAlerts = {
  windowDays: number;
  expiredCount: number;
  expiringCount: number;
  expiredQty: number;
  expiringQty: number;
  items: ExpiryAlertItem[];
};

export async function getExpiryAlerts(
  branchId: string | null,
  now: Date = new Date()
): Promise<ExpiryAlerts> {
  const branchObjectId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  const windowEnd = addDays(now, EXPIRING_WINDOW_DAYS);
  const branchMatch: Record<string, unknown> = branchObjectId ? { branchId: branchObjectId } : {};

  const batchRows = await InventoryMovement.aggregate([
    { $match: { expirationDate: { $ne: null, $lte: windowEnd }, ...branchMatch } },
    {
      $group: {
        _id: {
          productId: "$productId",
          batch: { $ifNull: ["$batchNumber", ""] },
          exp: "$expirationDate",
        },
        quantity: {
          $sum: {
            $cond: [
              { $in: ["$movementType", [...STOCK_IN_TYPES]] },
              "$quantity",
              { $multiply: ["$quantity", -1] },
            ],
          },
        },
      },
    },
    { $match: { quantity: { $gt: 0 } } },
    {
      $lookup: {
        from: "products",
        localField: "_id.productId",
        foreignField: "_id",
        as: "product",
      },
    },
    {
      $project: {
        productId: "$_id.productId",
        batch: "$_id.batch",
        exp: "$_id.exp",
        quantity: 1,
        name: { $arrayElemAt: ["$product.name", 0] },
        sku: { $arrayElemAt: ["$product.sku", 0] },
        barcode: { $arrayElemAt: ["$product.barcode", 0] },
        productStatus: { $arrayElemAt: ["$product.status", 0] },
      },
    },
    { $match: { productStatus: "active" } },
  ]);

  const items: ExpiryAlertItem[] = [];
  const datedProductIds = new Set<string>();
  let expiredQty = 0;
  let expiringQty = 0;

  for (const row of batchRows) {
    const status = classifyExpiration(row.exp, now);
    if (status !== "expired" && status !== "expiring") continue;
    const daysRemaining = daysUntil(row.exp, now) ?? 0;
    datedProductIds.add(String(row.productId));
    if (status === "expired") expiredQty += row.quantity;
    else expiringQty += row.quantity;
    items.push({
      productId: String(row.productId),
      name: row.name ?? "—",
      sku: row.sku ?? "",
      barcode: row.barcode ?? "",
      batchNumber: row.batch ?? "",
      quantity: row.quantity,
      expirationDate: new Date(row.exp).toISOString(),
      daysRemaining,
      status,
    });
  }

  // Product-level expiry fallback: only for products without dated batches.
  const productLevel = await Product.aggregate([
    { $match: { status: "active", expirationDate: { $ne: null } } },
    ...batchStockStages({ now, branchId: branchObjectId }),
    {
      $match: {
        $expr: { $or: [{ $gt: ["$expiredQty", 0] }, { $gt: ["$expiringQty", 0] }] },
      },
    },
    {
      $project: {
        name: 1,
        sku: 1,
        barcode: 1,
        expirationDate: 1,
        currentStock: 1,
        expiredQty: 1,
        expiringQty: 1,
      },
    },
  ]);

  for (const row of productLevel) {
    const productId = String(row._id);
    if (datedProductIds.has(productId)) continue;
    const status = classifyExpiration(row.expirationDate, now);
    if (status !== "expired" && status !== "expiring") continue;
    const quantity = status === "expired" ? row.expiredQty : row.expiringQty;
    if (!quantity) continue;
    if (status === "expired") expiredQty += quantity;
    else expiringQty += quantity;
    items.push({
      productId,
      name: row.name ?? "—",
      sku: row.sku ?? "",
      barcode: row.barcode ?? "",
      batchNumber: "",
      quantity,
      expirationDate: new Date(row.expirationDate).toISOString(),
      daysRemaining: daysUntil(row.expirationDate, now) ?? 0,
      status,
    });
  }

  items.sort((a, b) => a.daysRemaining - b.daysRemaining);

  const expiredProducts = new Set(items.filter((i) => i.status === "expired").map((i) => i.productId));
  const expiringProducts = new Set(
    items.filter((i) => i.status === "expiring").map((i) => i.productId)
  );

  return {
    windowDays: EXPIRING_WINDOW_DAYS,
    expiredCount: expiredProducts.size,
    expiringCount: expiringProducts.size,
    expiredQty,
    expiringQty,
    items,
  };
}
