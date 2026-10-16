import mongoose from "mongoose";
import { SaleReturn } from "@/models";

/**
 * Approved-returns (refunds) aggregation helpers — server-only.
 *
 * Every financial report must net refunds the same way the dashboard does,
 * so the two can never drift. All functions below bucket a return by the
 * moment money actually moved (approval time when present, otherwise
 * creation), count only `approved` returns, and are branch-scoped exactly
 * like their sales counterparts.
 *
 * Kept out of `@/lib/reports` on purpose: that module is imported by the
 * pure-function unit tests, which must not pull in mongoose/models.
 */

/** Returns are bucketed by approval moment (falling back to creation). */
export const RETURN_TIME_EXPR = { $ifNull: ["$approvedAt", "$createdAt"] };

/** A $match fragment selecting approved returns whose money moved inside the window. */
export function approvedReturnsMatch(
  start: Date,
  branchId?: mongoose.Types.ObjectId | null,
  end?: Date
): Record<string, unknown> {
  const timeCond: Record<string, unknown> = end
    ? { $and: [{ $gte: [RETURN_TIME_EXPR, start] }, { $lte: [RETURN_TIME_EXPR, end] }] }
    : { $gte: [RETURN_TIME_EXPR, start] };
  return {
    status: "approved",
    ...(branchId ? { branchId } : {}),
    $expr: timeCond,
  };
}

export type ReturnsTotals = {
  refund: number;
  net: number;
  cogs: number;
  count: number;
};

const EMPTY_RETURNS: ReturnsTotals = { refund: 0, net: 0, cogs: 0, count: 0 };

/** Local round2 (identical to commerce.round2 — avoids a circular import). */
function round2Local(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Aggregate approved-returns totals in the window (refund total, net, COGS, count). */
export async function approvedReturnsTotals(
  start: Date,
  branchId?: mongoose.Types.ObjectId | null,
  end?: Date
): Promise<ReturnsTotals> {
  const [agg] = await SaleReturn.aggregate([
    { $match: approvedReturnsMatch(start, branchId, end) },
    {
      $group: {
        _id: null,
        refund: { $sum: "$total" },
        net: { $sum: { $subtract: ["$subtotal", "$discount"] } },
        count: { $sum: 1 },
        cogs: {
          $sum: {
            $sum: {
              $map: { input: "$items", as: "i", in: { $multiply: ["$$i.costPrice", "$$i.quantity"] } },
            },
          },
        },
      },
    },
  ]);
  if (!agg) return { ...EMPTY_RETURNS };
  return {
    refund: round2Local(agg.refund ?? 0),
    net: round2Local(agg.net ?? 0),
    cogs: round2Local(agg.cogs ?? 0),
    count: agg.count ?? 0,
  };
}

export type ReturnsByDayRow = { day: string; refund: number; net: number; cogs: number };

/** Per-day approved-returns breakdown (UTC day buckets) in the window. */
export async function approvedReturnsByDay(
  start: Date,
  branchId?: mongoose.Types.ObjectId | null,
  end?: Date
): Promise<ReturnsByDayRow[]> {
  const rows = await SaleReturn.aggregate([
    { $match: approvedReturnsMatch(start, branchId, end) },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: RETURN_TIME_EXPR } },
        refund: { $sum: "$total" },
        net: { $sum: { $subtract: ["$subtotal", "$discount"] } },
        cogs: {
          $sum: {
            $sum: {
              $map: { input: "$items", as: "i", in: { $multiply: ["$$i.costPrice", "$$i.quantity"] } },
            },
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({
    day: r._id as string,
    refund: round2Local(r.refund ?? 0),
    net: round2Local(r.net ?? 0),
    cogs: round2Local(r.cogs ?? 0),
  }));
}

export type ReturnsByProductRow = { productId: string; quantity: number; refund: number; cogs: number };

/** Per-product approved-returns breakdown in the window (unwinds return items). */
export async function approvedReturnsByProduct(
  start: Date,
  branchId?: mongoose.Types.ObjectId | null,
  end?: Date
): Promise<Map<string, ReturnsByProductRow>> {
  const rows = await SaleReturn.aggregate([
    { $match: approvedReturnsMatch(start, branchId, end) },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.productId",
        quantity: { $sum: "$items.quantity" },
        refund: { $sum: "$items.subtotal" },
        cogs: { $sum: { $multiply: ["$items.costPrice", "$items.quantity"] } },
      },
    },
  ]);
  const map = new Map<string, ReturnsByProductRow>();
  for (const r of rows) {
    map.set(String(r._id), {
      productId: String(r._id),
      quantity: r.quantity ?? 0,
      refund: round2Local(r.refund ?? 0),
      cogs: round2Local(r.cogs ?? 0),
    });
  }
  return map;
}
