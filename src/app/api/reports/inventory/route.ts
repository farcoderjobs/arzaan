import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Product, InventoryMovement } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { parseReportRange, parsePage, escapeRegex, csvResponse } from "@/lib/reports";

/**
 * GET /api/reports/inventory
 * Params: view=stock|low|out|valuation|movements|adjustments, search, categoryId,
 *         period/from/to (movements & adjustments), page, perPage, format=csv
 *
 * Stock is derived from inventory movements (the source of truth), never a stored field.
 */

const STOCK_IN = ["PURCHASE_IN", "CUSTOMER_RETURN_IN", "ADJUSTMENT_IN", "STOCK_COUNT_IN"];

const stockExpr = null; // stock is computed per product after unwinding movements

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.reports.inventory))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const range = parseReportRange(searchParams);
    const { page, perPage, skip } = parsePage(searchParams);
    const view = searchParams.get("view")?.trim() || "stock";
    const search = searchParams.get("search")?.trim() ?? "";
    const categoryId = searchParams.get("categoryId")?.trim() ?? "";

    const branchMatch = user.branchId ? { branchId: new mongoose.Types.ObjectId(user.branchId) } : {};
    const movementBranchMatch = user.branchId ? { branchId: new mongoose.Types.ObjectId(user.branchId) } : {};

    // Stock-level aggregation per product (with product metadata).
    // Movements are unwound first, signed, then summed per product.
    const stockBase: mongoose.PipelineStage[] = [
      { $match: { status: { $ne: "archived" }, ...(categoryId ? { categoryId: new mongoose.Types.ObjectId(categoryId) } : {}), ...(search ? { $or: [{ name: new RegExp(escapeRegex(search), "i") }, { sku: new RegExp(escapeRegex(search), "i") }] } : {}) } },
      {
        $lookup: {
          from: "inventorymovements",
          as: "m",
          let: { pid: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$productId", "$$pid"] }, ...movementBranchMatch } },
            { $project: { movementType: 1, quantity: 1 } },
          ],
        },
      },
      { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          signedQty: {
            $cond: [
              { $in: [{ $ifNull: ["$m.movementType", ""] }, STOCK_IN] },
              { $ifNull: ["$m.quantity", 0] },
              { $multiply: [{ $ifNull: ["$m.quantity", 0] }, -1] },
            ],
          },
        },
      },
      {
        $group: {
          _id: "$_id",
          name: { $first: "$name" },
          sku: { $first: "$sku" },
          costPrice: { $first: "$costPrice" },
          sellingPrice: { $first: "$sellingPrice" },
          reorderPoint: { $first: "$reorderPoint" },
          stock: { $sum: "$signedQty" },
        },
      },
    ];

    if (view === "movements") {
      const match: Record<string, unknown> = { createdAt: { $gte: range.from, $lte: range.to }, ...branchMatch };
      if (search) match.$or = [{ note: new RegExp(escapeRegex(search), "i") }];
      const [total, movements, totals] = await Promise.all([
        InventoryMovement.countDocuments(match),
        InventoryMovement.aggregate([
          { $match: match },
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: perPage },
          { $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "product" } },
          { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
          {
            $project: {
              createdAt: 1,
              movementType: 1,
              quantity: 1,
              unitCost: 1,
              note: 1,
              productName: { $arrayElemAt: ["$product.name", 0] },
              sku: { $arrayElemAt: ["$product.sku", 0] },
              userName: { $arrayElemAt: ["$user.name", 0] },
            },
          },
        ]),
        InventoryMovement.aggregate([{ $match: match }, { $group: { _id: null, units: { $sum: "$quantity" } } }]),
      ]);

      const rows = movements.map((mv) => ({
        _id: mv._id.toString(),
        createdAt: mv.createdAt,
        movementType: mv.movementType,
        quantity: mv.quantity,
        unitCost: mv.unitCost,
        note: mv.note,
        productName: mv.productName ?? "—",
        sku: mv.sku ?? "",
        userName: mv.userName ?? "—",
      }));

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Date", "Product", "SKU", "Movement", "Quantity", "Unit Cost", "Note"]];
        for (const r of rows) csvRows.push([r.createdAt.toISOString(), r.productName, r.sku, r.movementType, r.quantity, r.unitCost, r.note]);
        return csvResponse(`stock-movements-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        rows,
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
        summary: { units: totals[0]?.units ?? 0 },
      });
    }

    if (view === "adjustments") {
      const match: Record<string, unknown> = {
        createdAt: { $gte: range.from, $lte: range.to },
        movementType: { $in: ["ADJUSTMENT_IN", "ADJUSTMENT_OUT", "STOCK_COUNT_IN", "STOCK_COUNT_OUT"] },
        ...branchMatch,
      };
      const [total, adjustments] = await Promise.all([
        InventoryMovement.countDocuments(match),
        InventoryMovement.aggregate([
          { $match: match },
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: perPage },
          { $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "product" } },
          { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
          {
            $project: {
              createdAt: 1,
              movementType: 1,
              quantity: 1,
              unitCost: 1,
              note: 1,
              productName: { $arrayElemAt: ["$product.name", 0] },
              sku: { $arrayElemAt: ["$product.sku", 0] },
              userName: { $arrayElemAt: ["$user.name", 0] },
            },
          },
        ]),
      ]);

      const rows = adjustments.map((mv) => ({
        _id: mv._id.toString(),
        createdAt: mv.createdAt,
        movementType: mv.movementType,
        quantity: mv.quantity,
        unitCost: mv.unitCost,
        note: mv.note,
        productName: mv.productName ?? "—",
        sku: mv.sku ?? "",
        userName: mv.userName ?? "—",
      }));

      if (searchParams.get("format") === "csv") {
        const csvRows: Array<Array<string | number>> = [["Date", "Product", "SKU", "Adjustment", "Quantity", "Unit Cost", "Note"]];
        for (const r of rows) csvRows.push([r.createdAt.toISOString(), r.productName, r.sku, r.movementType, r.quantity, r.unitCost, r.note]);
        return csvResponse(`inventory-adjustments-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
      }

      return NextResponse.json({
        view,
        rows,
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
      });
    }

    // Stock-based views: stock | low | out | valuation
    // Aggregate per product then filter in the pipeline (kept in DB, paginated).
    const stockPipeline: mongoose.PipelineStage[] = [...stockBase];

    if (view === "low") stockPipeline.push({ $match: { $expr: { $and: [{ $gt: ["$stock", 0] }, { $lte: ["$stock", "$reorderPoint"] }] } } });
    if (view === "out") stockPipeline.push({ $match: { stock: { $lte: 0 } } });
    if (view === "stock") stockPipeline.push({ $match: { stock: { $gt: 0 } } });

    const countResult = await Product.aggregate([...stockPipeline, { $count: "total" }]);
    const total = countResult[0]?.total ?? 0;

    let valueResult: Array<{ value: number }> = [];
    if (view === "valuation") {
      valueResult = await Product.aggregate([
        ...stockPipeline,
        { $project: { value: { $multiply: ["$stock", "$costPrice"] } } },
        { $group: { _id: null, value: { $sum: "$value" } } },
      ]);
    }

    const sortField = view === "valuation" ? "value" : "stock";
    stockPipeline.push(
      { $addFields: view === "valuation" ? { value: { $multiply: ["$stock", "$costPrice"] } } : {} },
      { $sort: { [sortField]: 1 } },
      { $skip: skip },
      { $limit: perPage }
    );

    const products = await Product.aggregate(stockPipeline);

    const rows = products.map((p) => ({
      _id: p._id.toString(),
      name: p.name,
      sku: p.sku ?? "",
      stock: p.stock ?? 0,
      reorderPoint: p.reorderPoint ?? 0,
      costPrice: p.costPrice ?? 0,
      sellingPrice: p.sellingPrice ?? 0,
      value: round2((p.stock ?? 0) * (p.costPrice ?? 0)),
      retailValue: round2((p.stock ?? 0) * (p.sellingPrice ?? 0)),
    }));

    if (searchParams.get("format") === "csv") {
      const header =
        view === "valuation"
          ? [["Product", "SKU", "Stock", "Cost Price", "Stock Value", "Retail Value"]]
          : [["Product", "SKU", "Stock", "Reorder Point", "Cost Price", "Selling Price"]];
      const csvRows = [...header];
      for (const r of rows) {
        if (view === "valuation") csvRows.push([r.name, r.sku, r.stock, r.costPrice, r.value, r.retailValue]);
        else csvRows.push([r.name, r.sku, r.stock, r.reorderPoint, r.costPrice, r.sellingPrice]);
      }
      return csvResponse(`inventory-${view}-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
    }

    return NextResponse.json({
      view,
      rows,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      summary: view === "valuation" ? { totalValue: round2(valueResult[0]?.value ?? 0) } : undefined,
    });
  } catch (error) {
    console.error("GET /api/reports/inventory error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
