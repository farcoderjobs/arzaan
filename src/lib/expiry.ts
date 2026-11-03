import mongoose from "mongoose";

/**
 * Expiration / batch rules — shared by the dashboard alerts, the inventory
 * screen, purchase receiving and the POS expiry guard.
 *
 * Batches are not a separate collection: a batch is a group of inventory
 * movements (same product + batch number + expiry) whose signed quantities
 * add up to what is still on hand. Expired stock is therefore never deleted —
 * it keeps counting in stock math and simply stops being sellable by default.
 */

export const EXPIRING_WINDOW_DAYS = 30;

/** Movement types that add stock — the single stock direction rule. */
export const STOCK_IN_TYPES = [
  "PURCHASE_IN",
  "CUSTOMER_RETURN_IN",
  "ADJUSTMENT_IN",
  "STOCK_COUNT_IN",
  "TRANSFER_IN",
] as const;

export type ExpiryStatus = "expired" | "expiring" | "ok" | "none";

export function startOfDay(value: Date): Date {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(value: Date, days: number): Date {
  const d = new Date(value);
  d.setDate(d.getDate() + days);
  return d;
}

/** Calendar-day distance to the expiry date (negative = already expired). */
export function daysUntil(
  expiration: Date | string | null | undefined,
  now: Date = new Date()
): number | null {
  if (!expiration) return null;
  const exp = expiration instanceof Date ? expiration : new Date(expiration);
  if (Number.isNaN(exp.getTime())) return null;
  const ms = startOfDay(exp).getTime() - startOfDay(now).getTime();
  return Math.round(ms / 86_400_000);
}

export function classifyExpiration(
  expiration: Date | string | null | undefined,
  now: Date = new Date()
): ExpiryStatus {
  const days = daysUntil(expiration, now);
  if (days === null) return "none";
  if (days < 0) return "expired";
  if (days <= EXPIRING_WINDOW_DAYS) return "expiring";
  return "ok";
}

export type BatchLike = {
  batchNumber?: string;
  expirationDate?: Date | string | null;
  /** Remaining quantity in the batch (already signed). */
  quantity: number;
  /** Import/local origin of the stock; null when unknown (legacy). */
  purchaseSource?: "import" | "local" | null;
};

export type ExpirySummary = {
  /** Units on hand whose batch is past its expiry date. */
  expiredQty: number;
  /** Units on hand expiring within the next 30 days (not yet expired). */
  expiringQty: number;
  /** Units on hand belonging to a dated batch. */
  datedQty: number;
  /** Total units on hand across all batches. */
  quantity: number;
  earliestExpiration: Date | null;
  status: ExpiryStatus;
};

/**
 * Summarizes dated batches. Products without expiration dates report
 * `status: "none"` and zero quantities — they are never treated as expired.
 */
export function summarizeBatches(
  batches: BatchLike[],
  now: Date = new Date()
): ExpirySummary {
  let expiredQty = 0;
  let expiringQty = 0;
  let datedQty = 0;
  let quantity = 0;
  let earliestExpiration: Date | null = null;

  for (const batch of batches) {
    const qty = Number(batch.quantity ?? 0);
    quantity += qty;
    const exp = batch.expirationDate
      ? batch.expirationDate instanceof Date
        ? batch.expirationDate
        : new Date(batch.expirationDate)
      : null;
    if (!exp || Number.isNaN(exp.getTime())) continue;
    if (qty > 0) datedQty += qty;
    if (earliestExpiration === null || exp.getTime() < earliestExpiration.getTime()) {
      earliestExpiration = exp;
    }
    if (qty <= 0) continue;
    const status = classifyExpiration(exp, now);
    if (status === "expired") expiredQty += qty;
    else if (status === "expiring") expiringQty += qty;
  }

  const status: ExpiryStatus =
    expiredQty > 0
      ? "expired"
      : expiringQty > 0
        ? "expiring"
        : earliestExpiration
          ? "ok"
          : "none";

  return { expiredQty, expiringQty, datedQty, quantity, earliestExpiration, status };
}

export type BatchAllocation = {
  batchNumber: string;
  expirationDate: Date | null;
  quantity: number;
  purchaseSource?: "import" | "local" | null;
};

/**
 * Allocates a sold quantity across batches, first-expired-first-out.
 * Expired batches are skipped unless `allowExpired` is set, and even then they
 * are only consumed after every non-expired batch is exhausted.
 */
export function allocateQuantity(
  batches: BatchLike[],
  quantity: number,
  options: { allowExpired?: boolean; now?: Date } = {}
): BatchAllocation[] {
  const now = options.now ?? new Date();
  const remaining: Array<BatchAllocation> = batches
    .map((b) => ({
      batchNumber: b.batchNumber ?? "",
      expirationDate: b.expirationDate
        ? b.expirationDate instanceof Date
          ? b.expirationDate
          : new Date(b.expirationDate)
        : null,
      quantity: Math.max(0, Number(b.quantity ?? 0)),
      // Only present when the caller tracks origin, so plain batch objects keep
      // their exact shape.
      ...(b.purchaseSource !== undefined ? { purchaseSource: b.purchaseSource ?? null } : {}),
    }))
    .filter((b) => b.quantity > 0);

  const isExpired = (b: BatchAllocation) => classifyExpiration(b.expirationDate, now) === "expired";

  remaining.sort((a, b) => {
    const aExpired = isExpired(a);
    const bExpired = isExpired(b);
    // Prefer sellable batches, then earliest expiry; undated stock last.
    if (aExpired !== bExpired) return aExpired ? 1 : -1;
    if (a.expirationDate === null && b.expirationDate === null) return 0;
    if (a.expirationDate === null) return 1;
    if (b.expirationDate === null) return -1;
    return a.expirationDate.getTime() - b.expirationDate.getTime();
  });

  let left = Math.max(0, Math.floor(quantity));
  const allocations: BatchAllocation[] = [];
  for (const batch of remaining) {
    if (left <= 0) break;
    if (isExpired(batch) && !options.allowExpired) continue;
    const take = Math.min(left, batch.quantity);
    if (take <= 0) continue;
    allocations.push({ ...batch, quantity: take });
    left -= take;
  }
  return allocations;
}

/** Units on hand that may still be sold without an override. */
export function sellableQuantity(batches: BatchLike[], now: Date = new Date()): number {
  return batches.reduce((sum, batch) => {
    const qty = Number(batch.quantity ?? 0);
    if (qty <= 0) return sum;
    return classifyExpiration(batch.expirationDate, now) === "expired" ? sum : sum + qty;
  }, 0);
}

/** Units on hand that are already expired (for the POS guard message). */
export function expiredQuantity(batches: BatchLike[], now: Date = new Date()): number {
  return batches.reduce((sum, batch) => {
    const qty = Number(batch.quantity ?? 0);
    if (qty <= 0) return sum;
    return classifyExpiration(batch.expirationDate, now) === "expired" ? sum + qty : sum;
  }, 0);
}

const signForMovementType = {
  $cond: [
    { $in: ["$movementType", [...STOCK_IN_TYPES]] },
    "$quantity",
    { $multiply: ["$quantity", -1] },
  ],
};

/**
 * Aggregation stages that attach per-product batch/expiry information from the
 * inventory movement ledger:
 *   batchInfo, currentStock, expiredQty, expiringQty, earliestExpiration
 *
 * Products with no dated batch fall back to their own `expirationDate`, so a
 * manually dated product is still reported. Products without any expiration
 * date get zeros and a null date.
 */
export function batchStockStages(options: {
  now?: Date;
  branchId?: mongoose.Types.ObjectId | null;
  /** Standalone warehouse location (mutually exclusive with branchId). */
  warehouseId?: mongoose.Types.ObjectId | null;
} = {}): mongoose.PipelineStage[] {
  const now = options.now ?? new Date();
  const windowEnd = addDays(now, EXPIRING_WINDOW_DAYS);
  const branchMatch: Record<string, unknown> = {};
  if (options.branchId) branchMatch.branchId = options.branchId;
  if (options.warehouseId) branchMatch.warehouseId = options.warehouseId;

  return [
    {
      $lookup: {
        from: "inventorymovements",
        let: { pid: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$productId", "$$pid"] }, ...branchMatch } },
          {
            $group: {
              _id: {
                batch: { $ifNull: ["$batchNumber", ""] },
                exp: "$expirationDate",
              },
              quantity: { $sum: signForMovementType },
              movementType: { $first: "$movementType" },
            },
          },
          {
            $group: {
              _id: null,
              stock: { $sum: "$quantity" },
              datedQty: {
                $sum: {
                  $cond: [
                    { $and: [{ $ne: ["$_id.exp", null] }, { $gt: ["$quantity", 0] }] },
                    "$quantity",
                    0,
                  ],
                },
              },
              expiredQty: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$_id.exp", null] },
                        { $gt: ["$quantity", 0] },
                        { $lt: ["$_id.exp", now] },
                      ],
                    },
                    "$quantity",
                    0,
                  ],
                },
              },
              expiringQty: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$_id.exp", null] },
                        { $gt: ["$quantity", 0] },
                        { $gte: ["$_id.exp", now] },
                        { $lte: ["$_id.exp", windowEnd] },
                      ],
                    },
                    "$quantity",
                    0,
                  ],
                },
              },
              earliestExpiration: { $min: "$_id.exp" },
            },
          },
        ],
        as: "batchInfo",
      },
    },
    { $addFields: { batchInfo: { $arrayElemAt: ["$batchInfo", 0] } } },
    {
      $addFields: {
        currentStock: { $ifNull: ["$batchInfo.stock", 0] },
        // A product with dated batches uses the batch expiry; otherwise its own
        // product-level expiration date applies to the whole on-hand stock.
        expiredQty: {
          $cond: [
            { $gt: [{ $ifNull: ["$batchInfo.datedQty", 0] }, 0] },
            { $ifNull: ["$batchInfo.expiredQty", 0] },
            {
              $cond: [
                {
                  $and: [
                    { $ne: ["$expirationDate", null] },
                    { $lt: ["$expirationDate", now] },
                    { $gt: [{ $ifNull: ["$batchInfo.stock", 0] }, 0] },
                  ],
                },
                { $ifNull: ["$batchInfo.stock", 0] },
                0,
              ],
            },
          ],
        },
        expiringQty: {
          $cond: [
            { $gt: [{ $ifNull: ["$batchInfo.datedQty", 0] }, 0] },
            { $ifNull: ["$batchInfo.expiringQty", 0] },
            {
              $cond: [
                {
                  $and: [
                    { $ne: ["$expirationDate", null] },
                    { $gte: ["$expirationDate", now] },
                    { $lte: ["$expirationDate", windowEnd] },
                    { $gt: [{ $ifNull: ["$batchInfo.stock", 0] }, 0] },
                  ],
                },
                { $ifNull: ["$batchInfo.stock", 0] },
                0,
              ],
            },
          ],
        },
        earliestExpiration: {
          $ifNull: ["$batchInfo.earliestExpiration", "$expirationDate"],
        },
      },
    },
    { $project: { batchInfo: 0 } },
  ];
}
