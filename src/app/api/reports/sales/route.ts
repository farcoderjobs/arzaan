import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Sale } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { parseReportRange, parsePage, csvResponse } from "@/lib/reports";
import { approvedReturnsTotals, approvedReturnsByDay } from "@/lib/report-returns";

/**
 * GET /api/reports/sales
 * Params: period=day|week|month | from&to (custom range), groupBy=day|cashier|customer|paymentMethod|category,
 *         cashierId, customerId, page, perPage, format=csv
 */

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.reports.sales))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const range = parseReportRange(searchParams);
    const { page, perPage, skip } = parsePage(searchParams);
    const groupBy = searchParams.get("groupBy")?.trim() || "day";
    const cashierId = searchParams.get("cashierId")?.trim() ?? "";
    const customerId = searchParams.get("customerId")?.trim() ?? "";

    const baseMatch: Record<string, unknown> = {
      status: "completed",
      createdAt: { $gte: range.from, $lte: range.to },
    };
    if (user.branchId) baseMatch.branchId = new mongoose.Types.ObjectId(user.branchId);
    if (cashierId) baseMatch.cashierId = new mongoose.Types.ObjectId(cashierId);
    if (customerId) baseMatch.customerId = new mongoose.Types.ObjectId(customerId);

    const netRevenueExpr = { $subtract: ["$subtotal", "$discount"] };

    // Summary (single aggregation)
    const summaryAgg = await Sale.aggregate<Record<string, number>>([
      { $match: baseMatch },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$total" },
          netRevenue: { $sum: netRevenueExpr },
          tax: { $sum: "$tax" },
          discounts: { $sum: "$discount" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Approved refunds in the same window (identical rules to the dashboard
    // sales KPI, so both screens always agree on net sales).
    const branchIdObj = user.branchId ? new mongoose.Types.ObjectId(user.branchId) : null;
    const [returnsTotals, returnsByDay] = await Promise.all([
      approvedReturnsTotals(range.from, branchIdObj, range.to),
      approvedReturnsByDay(range.from, branchIdObj, range.to),
    ]);
    const returnsByDayMap = new Map(returnsByDay.map((r) => [r.day, r]));

    const grossRevenue = round2(summaryAgg[0]?.revenue ?? 0);
    const summary = {
      revenue: grossRevenue,
      // Net sales = gross sales − approved refunds (what the dashboard shows).
      netSales: round2(grossRevenue - returnsTotals.refund),
      refunds: returnsTotals.refund,
      returnsCount: returnsTotals.count,
      netRevenue: round2(summaryAgg[0]?.netRevenue ?? 0),
      tax: round2(summaryAgg[0]?.tax ?? 0),
      discounts: round2(summaryAgg[0]?.discounts ?? 0),
      count: summaryAgg[0]?.count ?? 0,
      avgTicket: summaryAgg[0]?.count ? round2((summaryAgg[0].revenue ?? 0) / summaryAgg[0].count) : 0,
    };

    // Payment method split (unwind payments)
    const paymentSplit = await Sale.aggregate<{ _id: string; total: number }>([
      { $match: baseMatch },
      { $unwind: "$payments" },
      { $group: { _id: "$payments.method", total: { $sum: "$payments.amount" } } },
      { $sort: { total: -1 } },
    ]);

    let breakdown: Array<Record<string, unknown>> = [];
    let breakdownTotal = 0;

    if (groupBy === "day") {
      breakdown = await Sale.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            revenue: { $sum: "$total" },
            netRevenue: { $sum: netRevenueExpr },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $skip: skip },
        { $limit: perPage },
      ]);
      // Net out same-day approved refunds so each row matches the dashboard chart.
      breakdown = breakdown.map((row) => {
        const ret = returnsByDayMap.get(row._id as string);
        if (!ret) return row;
        return {
          ...row,
          revenue: round2(((row.revenue as number) ?? 0) - ret.refund),
          netRevenue: round2(((row.netRevenue as number) ?? 0) - ret.net),
          refunds: ret.refund,
        };
      });
      breakdownTotal = await Sale.aggregate([
        { $match: baseMatch },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } } } },
        { $count: "total" },
      ]).then((r) => r[0]?.total ?? 0);
    } else if (groupBy === "cashier") {
      breakdown = await Sale.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: "$cashierId",
            revenue: { $sum: "$total" },
            netRevenue: { $sum: netRevenueExpr },
            count: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $skip: skip },
        { $limit: perPage },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
        { $project: { name: { $arrayElemAt: ["$user.name", 0] }, revenue: 1, netRevenue: 1, count: 1 } },
      ]);
      breakdownTotal = await Sale.aggregate([
        { $match: baseMatch },
        { $group: { _id: "$cashierId" } },
        { $count: "total" },
      ]).then((r) => r[0]?.total ?? 0);
    } else if (groupBy === "customer") {
      breakdown = await Sale.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: "$customerId",
            revenue: { $sum: "$total" },
            netRevenue: { $sum: netRevenueExpr },
            count: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $skip: skip },
        { $limit: perPage },
        { $lookup: { from: "customers", localField: "_id", foreignField: "_id", as: "customer" } },
        {
          $project: {
            name: { $ifNull: [{ $arrayElemAt: ["$customer.name", 0] }, "Walk-in"] },
            revenue: 1,
            netRevenue: 1,
            count: 1,
          },
        },
      ]);
      breakdownTotal = await Sale.aggregate([
        { $match: baseMatch },
        { $group: { _id: "$customerId" } },
        { $count: "total" },
      ]).then((r) => r[0]?.total ?? 0);
    } else if (groupBy === "category") {
      // Roll sale items up to product categories via a product lookup
      breakdown = await Sale.aggregate([
        { $match: baseMatch },
        { $unwind: "$items" },
        {
          $lookup: {
            from: "products",
            localField: "items.productId",
            foreignField: "_id",
            as: "product",
          },
        },
        { $addFields: { categoryId: { $arrayElemAt: ["$product.categoryId", 0] } } },
        {
          $group: {
            _id: "$categoryId",
            quantity: { $sum: "$items.quantity" },
            revenue: { $sum: "$items.subtotal" },
          },
        },
        { $sort: { revenue: -1 } },
        { $skip: skip },
        { $limit: perPage },
        { $lookup: { from: "categories", localField: "_id", foreignField: "_id", as: "category" } },
        {
          $project: {
            name: { $ifNull: [{ $arrayElemAt: ["$category.name", 0] }, "Uncategorized"] },
            quantity: 1,
            revenue: 1,
          },
        },
      ]);
      breakdownTotal = await Sale.aggregate([
        { $match: baseMatch },
        { $unwind: "$items" },
        {
          $lookup: { from: "products", localField: "items.productId", foreignField: "_id", as: "product" },
        },
        { $addFields: { categoryId: { $arrayElemAt: ["$product.categoryId", 0] } } },
        { $group: { _id: "$categoryId" } },
        { $count: "total" },
      ]).then((r) => r[0]?.total ?? 0);
    }

    // Normalize breakdown rows
    const rows = breakdown.map((b) => ({
      label: (b.name as string) ?? (b._id as string) ?? "—",
      revenue: round2((b.revenue as number) ?? 0),
      netRevenue: round2((b.netRevenue as number) ?? 0),
      refunds: round2((b.refunds as number) ?? 0),
      quantity: (b.quantity as number) ?? null,
      count: (b.count as number) ?? null,
    }));

    if (searchParams.get("format") === "csv") {
      const csvRows: Array<Array<string | number>> = [["Group", "Revenue (net of refunds)", "Net Revenue", "Refunds", "Transactions"]];
      for (const r of rows) csvRows.push([r.label, r.revenue, r.netRevenue, r.refunds, r.count ?? 0]);
      csvRows.push([]);
      csvRows.push(["TOTAL (range)", summary.netSales, summary.netRevenue, summary.refunds, summary.count]);
      csvRows.push([]);
      csvRows.push(["Payment method", "Total"]);
      for (const p of paymentSplit) csvRows.push([p._id, round2(p.total)]);
      return csvResponse(`sales-report-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
    }

    return NextResponse.json({
      range: { from: range.from, to: range.to },
      summary,
      paymentSplit: paymentSplit.map((p) => ({ method: p._id, total: round2(p.total) })),
      groupBy,
      rows,
      total: breakdownTotal,
      page,
      perPage,
      totalPages: Math.ceil(breakdownTotal / perPage),
    });
  } catch (error) {
    console.error("GET /api/reports/sales error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
