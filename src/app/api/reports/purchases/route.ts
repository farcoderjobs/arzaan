import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Purchase } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { parseReportRange, parsePage, csvResponse } from "@/lib/reports";

/**
 * GET /api/reports/purchases
 * Params: period | from&to, view=summary|by-supplier|by-product|outstanding,
 *         supplierId, page, perPage, format=csv
 */

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.reports.purchases))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const range = parseReportRange(searchParams);
    const { page, perPage, skip } = parsePage(searchParams);
    const view = searchParams.get("view")?.trim() || "by-supplier";
    const supplierId = searchParams.get("supplierId")?.trim() ?? "";

    const baseMatch: Record<string, unknown> = {
      status: { $in: ["completed", "pending"] },
      createdAt: { $gte: range.from, $lte: range.to },
    };
    if (user.branchId) baseMatch.branchId = new mongoose.Types.ObjectId(user.branchId);
    if (supplierId) baseMatch.supplierId = new mongoose.Types.ObjectId(supplierId);

    if (view === "summary") {
      const [totals] = await Purchase.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: null,
            total: { $sum: "$total" },
            paid: { $sum: "$paidAmount" },
            due: { $sum: "$dueAmount" },
            count: { $sum: 1 },
          },
        },
      ]);
      return NextResponse.json({
        view,
        summary: {
          total: round2(totals?.total ?? 0),
          paid: round2(totals?.paid ?? 0),
          due: round2(totals?.due ?? 0),
          count: totals?.count ?? 0,
        },
      });
    }

    if (view === "outstanding") {
      // Current payables (all time) from the supplier ledger
      const outstandingPipeline: mongoose.PipelineStage[] = [
        { $group: { _id: "$supplierId", balance: { $sum: "$amount" } } },
        { $match: { balance: { $gt: 0.001 } } },
        { $sort: { balance: -1 } },
        { $skip: skip },
        { $limit: perPage },
        { $lookup: { from: "suppliers", localField: "_id", foreignField: "_id", as: "supplier" } },
        {
          $project: {
            name: { $arrayElemAt: ["$supplier.name", 0] },
            phone: { $arrayElemAt: ["$supplier.phone", 0] },
            balance: 1,
          },
        },
      ];

      const [rowsRaw, totalRaw, grand] = await Promise.all([
        mongoose.model("SupplierTransaction").aggregate(outstandingPipeline),
        mongoose.model("SupplierTransaction").aggregate([
          { $group: { _id: "$supplierId", balance: { $sum: "$amount" } } },
          { $match: { balance: { $gt: 0.001 } } },
          { $count: "total" },
        ]),
        mongoose.model("SupplierTransaction").aggregate([
          { $group: { _id: "$supplierId", balance: { $sum: "$amount" } } },
          { $match: { balance: { $gt: 0.001 } } },
          { $group: { _id: null, total: { $sum: "$balance" } } },
        ]),
      ]);

      const rows = rowsRaw.map((r) => ({
        _id: r._id?.toString() ?? "",
        name: r.name ?? "—",
        phone: r.phone ?? "",
        balance: round2(r.balance),
      }));

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Supplier", "Phone", "Outstanding Balance"]];
        for (const r of rows) csvRows.push([r.name, r.phone, r.balance]);
        csvRows.push([]);
        csvRows.push(["TOTAL OUTSTANDING", "", round2(grand[0]?.total ?? 0)]);
        return csvResponse(`supplier-outstanding-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        rows,
        total: totalRaw[0]?.total ?? 0,
        page,
        perPage,
        totalPages: Math.ceil((totalRaw[0]?.total ?? 0) / perPage),
        summary: { totalOutstanding: round2(grand[0]?.total ?? 0) },
      });
    }

    if (view === "by-product") {
      const [rowsRaw, totalRaw, totals] = await Promise.all([
        Purchase.aggregate([
          { $match: baseMatch },
          { $unwind: "$items" },
          {
            $group: {
              _id: "$items.productId",
              name: { $first: "$items.name" },
              sku: { $first: "$items.sku" },
              quantity: { $sum: "$items.quantity" },
              spend: { $sum: "$items.subtotal" },
            },
          },
          { $sort: { spend: -1 } },
          { $skip: skip },
          { $limit: perPage },
        ]),
        Purchase.aggregate([
          { $match: baseMatch },
          { $unwind: "$items" },
          { $group: { _id: "$items.productId" } },
          { $count: "total" },
        ]),
        Purchase.aggregate([
          { $match: baseMatch },
          { $unwind: "$items" },
          { $group: { _id: null, spend: { $sum: "$items.subtotal" }, quantity: { $sum: "$items.quantity" } } },
        ]),
      ]);

      const rows = rowsRaw.map((r) => ({
        _id: r._id?.toString() ?? "",
        name: r.name ?? "—",
        sku: r.sku ?? "",
        quantity: r.quantity ?? 0,
        spend: round2(r.spend ?? 0),
      }));

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Product", "SKU", "Quantity", "Spend"]];
        for (const r of rows) csvRows.push([r.name, r.sku, r.quantity, r.spend]);
        return csvResponse(`purchases-by-product-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        rows,
        total: totalRaw[0]?.total ?? 0,
        page,
        perPage,
        totalPages: Math.ceil((totalRaw[0]?.total ?? 0) / perPage),
        summary: { spend: round2(totals[0]?.spend ?? 0), quantity: totals[0]?.quantity ?? 0 },
      });
    }

    // Default: by-supplier
    const [rowsRaw, totalRaw, totals] = await Promise.all([
      Purchase.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: "$supplierId",
            total: { $sum: "$total" },
            paid: { $sum: "$paidAmount" },
            due: { $sum: "$dueAmount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { total: -1 } },
        { $skip: skip },
        { $limit: perPage },
        { $lookup: { from: "suppliers", localField: "_id", foreignField: "_id", as: "supplier" } },
        {
          $project: {
            name: { $arrayElemAt: ["$supplier.name", 0] },
            total: 1,
            paid: 1,
            due: 1,
            count: 1,
          },
        },
      ]),
      Purchase.aggregate([
        { $match: baseMatch },
        { $group: { _id: "$supplierId" } },
        { $count: "total" },
      ]),
      Purchase.aggregate([
        { $match: baseMatch },
        { $group: { _id: null, total: { $sum: "$total" }, due: { $sum: "$dueAmount" }, count: { $sum: 1 } } },
      ]),
    ]);

    const rows = rowsRaw.map((r) => ({
      _id: r._id?.toString() ?? "",
      name: r.name ?? "—",
      total: round2(r.total ?? 0),
      paid: round2(r.paid ?? 0),
      due: round2(r.due ?? 0),
      count: r.count ?? 0,
    }));

    if (searchParams.get("format") === "csv") {
      const csvRows: Array<Array<string | number>> = [["Supplier", "Purchases", "Paid", "Outstanding", "Orders"]];
      for (const r of rows) csvRows.push([r.name, r.total, r.paid, r.due, r.count]);
      csvRows.push([]);
      csvRows.push(["TOTAL", round2(totals[0]?.total ?? 0), "", round2(totals[0]?.due ?? 0), totals[0]?.count ?? 0]);
      return csvResponse(`purchases-by-supplier-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
    }

    return NextResponse.json({
      view,
      rows,
      total: totalRaw[0]?.total ?? 0,
      page,
      perPage,
      totalPages: Math.ceil((totalRaw[0]?.total ?? 0) / perPage),
      summary: { total: round2(totals[0]?.total ?? 0), due: round2(totals[0]?.due ?? 0), count: totals[0]?.count ?? 0 },
    });
  } catch (error) {
    console.error("GET /api/reports/purchases error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
