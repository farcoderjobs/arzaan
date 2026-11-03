import mongoose from "mongoose";
import { InventoryMovement } from "@/models";
import { STOCK_IN_TYPES, type BatchLike } from "@/lib/expiry";
import { escapeRegex } from "@/lib/reports";

/**
 * Warehouse stock.
 *
 * Warehouses are their own entity (not branches), so their stock lives in the
 * same inventory ledger keyed by `warehouseId` instead of `branchId`. Every
 * quantity is derived from movements — there is no stored stock field to drift.
 */

const signedQuantity = {
  $sum: {
    $cond: [
      { $in: ["$movementType", [...STOCK_IN_TYPES]] },
      "$quantity",
      { $multiply: ["$quantity", -1] },
    ],
  },
} as const;

export async function getWarehouseStockForProducts(
  productIds: string[],
  warehouseId: string,
  session?: mongoose.ClientSession | null
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (productIds.length === 0) return map;

  const pipeline: mongoose.PipelineStage[] = [
    {
      $match: {
        warehouseId: new mongoose.Types.ObjectId(warehouseId),
        productId: { $in: productIds.map((id) => new mongoose.Types.ObjectId(id)) },
      },
    },
    { $group: { _id: "$productId", stock: signedQuantity } },
  ];

  const rows = session
    ? await InventoryMovement.aggregate<{ _id: mongoose.Types.ObjectId; stock: number }>(pipeline, { session })
    : await InventoryMovement.aggregate<{ _id: mongoose.Types.ObjectId; stock: number }>(pipeline);

  for (const row of rows) map.set(String(row._id), row.stock);
  return map;
}

export type WarehouseBatch = BatchLike & {
  productId: string;
  batchNumber: string;
  expirationDate: Date | null;
  quantity: number;
  purchaseSource: "import" | "local" | null;
};

/**
 * Remaining per-batch quantities held by a warehouse, so a transfer out of the
 * warehouse keeps the same expiry and Import/Local traceability as a shop.
 */
export async function getWarehouseBatches(
  productIds: string[],
  warehouseId: string,
  session?: mongoose.ClientSession | null
): Promise<Map<string, WarehouseBatch[]>> {
  const result = new Map<string, WarehouseBatch[]>();
  if (productIds.length === 0) return result;

  const pipeline: mongoose.PipelineStage[] = [
    {
      $match: {
        warehouseId: new mongoose.Types.ObjectId(warehouseId),
        productId: { $in: productIds.map((id) => new mongoose.Types.ObjectId(id)) },
      },
    },
    {
      $group: {
        _id: {
          productId: "$productId",
          batch: { $ifNull: ["$batchNumber", ""] },
          exp: "$expirationDate",
          source: { $ifNull: ["$purchaseSource", null] },
        },
        quantity: signedQuantity,
      },
    },
    { $sort: { "_id.exp": 1 } },
  ];

  const rows = session
    ? await InventoryMovement.aggregate<WarehouseBatchRow>(pipeline, { session })
    : await InventoryMovement.aggregate<WarehouseBatchRow>(pipeline);

  for (const row of rows) {
    const productId = String(row._id.productId);
    const batch: WarehouseBatch = {
      productId,
      batchNumber: row._id.batch ?? "",
      expirationDate: row._id.exp ? new Date(row._id.exp) : null,
      quantity: row.quantity,
      purchaseSource:
        row._id.source === "import" || row._id.source === "local" ? row._id.source : null,
    };
    const list = result.get(productId);
    if (list) list.push(batch);
    else result.set(productId, [batch]);
  }
  return result;
}

export type WarehouseInventoryRow = {
  productId: string;
  name: string;
  sku: string;
  barcode: string;
  variantName: string;
  quantity: number;
  unitCost: number;
  value: number;
};

export async function listWarehouseInventory(options: {
  warehouseId: string;
  search?: string;
}): Promise<WarehouseInventoryRow[]> {
  const search = options.search?.trim() ?? "";
  const pipeline: mongoose.PipelineStage[] = [
    { $match: { warehouseId: new mongoose.Types.ObjectId(options.warehouseId) } },
    { $group: { _id: "$productId", quantity: signedQuantity, unitCost: { $last: "$unitCost" } } },
    { $match: { quantity: { $gt: 0 } } },
    {
      $lookup: {
        from: "products",
        localField: "_id",
        foreignField: "_id",
        as: "product",
      },
    },
    { $unwind: "$product" },
  ];
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    pipeline.push({
      $match: {
        $or: [{ "product.name": rx }, { "product.sku": rx }, { "product.barcode": rx }, { "product.variantName": rx }],
      },
    });
  }
  pipeline.push(
    {
      $project: {
        _id: 0,
        productId: { $toString: "$_id" },
        name: "$product.name",
        sku: { $ifNull: ["$product.sku", ""] },
        barcode: { $ifNull: ["$product.barcode", ""] },
        variantName: { $ifNull: ["$product.variantName", ""] },
        quantity: 1,
        unitCost: { $ifNull: ["$product.costPrice", "$unitCost"] },
        value: { $multiply: ["$quantity", { $ifNull: ["$product.costPrice", "$unitCost"] }] },
      },
    },
    { $sort: { name: 1 } }
  );

  return InventoryMovement.aggregate<WarehouseInventoryRow>(pipeline);
}

type WarehouseBatchRow = {
  _id: {
    productId: mongoose.Types.ObjectId;
    batch: string | null;
    exp: Date | null;
    source: string | null;
  };
  quantity: number;
};
