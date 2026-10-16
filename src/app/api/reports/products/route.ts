import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Sale, Product } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { parseReportRange, parsePage, csvResponse } from "@/lib/reports";
import { approvedReturnsByProduct } from "@/lib/report-returns";

/**
 * GET /api/reports/products
 * Params: period | from&to, view=sold|best|slow|never, categoryId, page, perPage, format=csv
 *
 * COGS is computed from the cost price snapshotted on each historical sale item
 * ($items.costPrice) — never from the product's current cost.
 */

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.reports.products))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const range = parseReportRange(searchParams);
    const { page, perPage, skip } = parsePage(searchParams);
    const view = searchParams.get("view")?.trim() || "sold";
    const categoryId = searchParams.get("categoryId")?.trim() ?? "";

    const baseMatch: Record<string, unknown> = {
      status: "completed",
      createdAt: { $gte: range.from, $lte: range.to },
    };
    if (user.branchId) baseMatch.branchId = new mongoose.Types.ObjectId(user.branchId);

    // Product-level rollup pipeline (shared core)
    const soldPipeline: mongoose.PipelineStage[] = [
      { $match: baseMatch },
      { $unwind: "$items" },
      ...(categoryId
        ? [
            {
              $lookup: {
                from: "products",
                localField: "items.productId",
                foreignField: "_id",
                as: "product",
              },
            },
            { $match: { "product.categoryId": new mongoose.Types.ObjectId(categoryId) } },
          ]
        : []),
      {
        $group: {
          _id: "$items.productId",
          name: { $first: "$items.name" },
          sku: { $first: "$items.sku" },
          quantitySold: { $sum: "$items.quantity" },
          revenue: { $sum: "$items.subtotal" },
          // COGS straight from the historical snapshot
          cogs: { $sum: { $multiply: ["$items.costPrice", "$items.quantity"] } },
          orders: { $sum: 1 },
          lastSoldAt: { $max: "$createdAt" },
        },
      },
      { $addFields: { grossProfit: { $subtract: ["$revenue", "$cogs"] } } },
    ];

    if (view === "never") {
      // Active products with zero sales in the range (aggregation over products, not the browser)
      const neverSold = await Product.aggregate([
        { $match: { status: { $ne: "archived" }, ...(categoryId ? { categoryId: new mongoose.Types.ObjectId(categoryId) } : {}) } },
        {
          $lookup: {
            from: "sales",
            as: "salesInRange",
            let: { pid: "$_id" },
            pipeline: [
              { $match: { $expr: { $and: [{ $eq: ["$items.productId", "$$pid"] }, { $eq: ["$status", "completed"] }, { $gte: ["$createdAt", range.from] }, { $lte: ["$createdAt", range.to] }] } } },
              { $limit: 1 },
            ],
          },
        },
        { $match: { salesInRange: { $size: 0 } } },
        { $skip: skip },
        { $limit: perPage },
        { $project: { name: 1, sku: 1, costPrice: 1, sellingPrice: 1, stockNote: { $literal: "No sales in range" } } },
      ]);
      const neverTotal = await Product.aggregate([
        { $match: { status: { $ne: "archived" }, ...(categoryId ? { categoryId: new mongoose.Types.ObjectId(categoryId) } : {}) } },
        {
          $lookup: {
            from: "sales",
            as: "salesInRange",
            let: { pid: "$_id" },
            pipeline: [
              { $match: { $expr: { $and: [{ $eq: ["$items.productId", "$$pid"] }, { $eq: ["$status", "completed"] }, { $gte: ["$createdAt", range.from] }, { $lte: ["$createdAt", range.to] }] } } },
              { $limit: 1 },
            ],
          },
        },
        { $match: { salesInRange: { $size: 0 } } },
        { $count: "total" },
      ]);

      const rows = neverSold.map((p) => ({
        _id: p._id.toString(),
        name: p.name,
        sku: p.sku ?? "",
        quantitySold: 0,
        revenue: 0,
        cogs: 0,
        grossProfit: 0,
        margin: null,
        lastSoldAt: null,
      }));

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Product", "SKU", "Quantity Sold", "Revenue", "COGS", "Gross Profit"]];
        for (const r of rows) csvRows.push([r.name, r.sku, 0, 0, 0, 0]);
        return csvResponse(`products-never-sold-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        rows,
        total: neverTotal[0]?.total ?? 0,
        page,
        perPage,
        totalPages: Math.ceil((neverTotal[0]?.total ?? 0) / perPage),
      });
    }

    const sortStage: mongoose.PipelineStage =
      view === "best" ? { $sort: { quantitySold: -1 } } : view === "slow" ? { $sort: { quantitySold: 1, lastSoldAt: 1 } } : { $sort: { revenue: -1 } };

    const countPipeline: mongoose.PipelineStage[] = [...soldPipeline, { $count: "total" }];
    const [totalResult] = await Sale.aggregate(countPipeline);
    const total = totalResult?.total ?? 0;

    const rowsPipeline: mongoose.PipelineStage[] = [...soldPipeline, sortStage, { $skip: skip }, { $limit: perPage }];
    const sold = await Sale.aggregate(rowsPipeline);

    // Net out approved returns in the range so per-product quantity, revenue,
    // COGS and profit agree with the dashboard / profit report.
    const branchIdObj = user.branchId ? new mongoose.Types.ObjectId(user.branchId) : null;
    const returnsByProduct = await approvedReturnsByProduct(range.from, branchIdObj, range.to);

    const rows = sold.map((p) => {
      const ret = returnsByProduct.get(String(p._id));
      const quantitySold = (p.quantitySold ?? 0) - (ret?.quantity ?? 0);
      const revenue = round2((p.revenue ?? 0) - (ret?.refund ?? 0));
      const cogs = round2((p.cogs ?? 0) - (ret?.cogs ?? 0));
      return {
        _id: p._id?.toString() ?? "",
        name: p.name ?? "—",
        sku: p.sku ?? "",
        quantitySold,
        returnedQty: ret?.quantity ?? 0,
        revenue,
        cogs,
        grossProfit: round2(revenue - cogs),
        margin: revenue ? round2(((revenue - cogs) / revenue) * 100) : 0,
        lastSoldAt: p.lastSoldAt ?? null,
        orders: p.orders ?? 0,
      };
    });

    if (searchParams.get("format") === "csv") {
      const csvRows: Array<Array<string | number>> = [["Product", "SKU", "Qty Sold", "Qty Returned", "Revenue", "COGS", "Gross Profit", "Margin %"]];
      for (const r of rows) csvRows.push([r.name, r.sku, r.quantitySold, r.returnedQty, r.revenue, r.cogs, r.grossProfit, r.margin]);
      return csvResponse(`products-${view}-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
    }

    return NextResponse.json({
      view,
      rows,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    console.error("GET /api/reports/products error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
