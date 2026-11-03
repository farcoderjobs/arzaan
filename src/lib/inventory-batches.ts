import mongoose from "mongoose";
import { InventoryMovement, PurchaseSource } from "@/models";
import { STOCK_IN_TYPES, type BatchLike } from "@/lib/expiry";

/**
 * Reads remaining batch quantities from the inventory ledger.
 * A batch is (productId, batchNumber, expirationDate, purchaseSource); its
 * remaining quantity is the signed sum of every movement carrying those
 * coordinates. Keeping the origin in the batch key means an Import and a Local
 * receipt that happen to share a batch/expiry code are still distinguishable.
 */

export type ProductBatch = BatchLike & {
  productId: string;
  batchNumber: string;
  expirationDate: Date | null;
  quantity: number;
  purchaseSource: PurchaseSource | null;
};

export async function getProductBatches(
  productIds: string[],
  branchId: string | null,
  session?: mongoose.ClientSession | null
): Promise<Map<string, ProductBatch[]>> {
  const result = new Map<string, ProductBatch[]>();
  if (productIds.length === 0) return result;

  const match: Record<string, unknown> = {
    productId: { $in: productIds.map((id) => new mongoose.Types.ObjectId(id)) },
  };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);

  const pipeline: mongoose.PipelineStage[] = [
    { $match: match },
    {
      $group: {
        _id: {
          productId: "$productId",
          batch: { $ifNull: ["$batchNumber", ""] },
          exp: "$expirationDate",
          source: { $ifNull: ["$purchaseSource", null] },
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
    { $sort: { "_id.exp": 1 } },
  ];

  const rows = session
    ? await InventoryMovement.aggregate<ProductBatchRow>(pipeline, { session })
    : await InventoryMovement.aggregate<ProductBatchRow>(pipeline);

  for (const row of rows) {
    const productId = String(row._id.productId);
    const batch: ProductBatch = {
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

type ProductBatchRow = {
  _id: {
    productId: mongoose.Types.ObjectId;
    batch: string | null;
    exp: Date | null;
    source: string | null;
  };
  quantity: number;
};
