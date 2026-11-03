import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Branch, InventoryMovement, Product, StockTransfer } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { STOCK_IN_TYPES } from "@/lib/expiry";
import { escapeRegex, csvResponse } from "@/lib/reports";

/**
 * GET /api/reports/locations
 *
 * Stock per product per location (warehouse or shop), derived from the
 * inventory ledger — the same source of truth the POS uses. Also returns:
 *   - inTransit: units dispatched but not yet received, per destination,
 *   - lowStock: rows at or below the product's reorder point.
 *
 * Params: search, branchId (HQ only), includeZero=1, format=csv
 */

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.reports.inventory))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search")?.trim() ?? "";
    const requestedBranch = searchParams.get("branchId")?.trim() ?? "";
    const includeZero = searchParams.get("includeZero") === "1";
    const format = searchParams.get("format")?.trim() ?? "";

    const branchId = user.branchId
      ? new mongoose.Types.ObjectId(user.branchId)
      : requestedBranch && mongoose.Types.ObjectId.isValid(requestedBranch)
        ? new mongoose.Types.ObjectId(requestedBranch)
        : null;

    const branches = await Branch.find(branchId ? { _id: branchId } : {})
      .select("name code type status")
      .sort({ name: 1 })
      .lean();

    const productMatch: Record<string, unknown> = { status: { $ne: "archived" } };
    if (search) {
      productMatch.$or = [
        { name: new RegExp(escapeRegex(search), "i") },
        { sku: new RegExp(escapeRegex(search), "i") },
        { barcode: new RegExp(escapeRegex(search), "i") },
      ];
    }
    const products = await Product.find(productMatch)
      .select("name sku barcode reorderPoint costPrice sellingPrice")
      .lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const movementMatch: Record<string, unknown> = {
      productId: { $in: products.map((p) => p._id) },
    };
    if (branchId) movementMatch.branchId = branchId;

    const stockRows = await InventoryMovement.aggregate([
      { $match: movementMatch },
      {
        $group: {
          _id: { productId: "$productId", branchId: "$branchId" },
          stock: {
            $sum: {
              $cond: [{ $in: ["$movementType", [...STOCK_IN_TYPES]] }, "$quantity", { $multiply: ["$quantity", -1] }],
            },
          },
        },
      },
    ]);

    // Units in transit by destination (dispatched quantity not yet received).
    const transferMatch: Record<string, unknown> = {
      status: { $in: ["dispatched", "partially_received"] },
    };
    if (branchId) transferMatch.toBranchId = branchId;
    const inTransitTransfers = await StockTransfer.find(transferMatch)
      .select("toBranchId items")
      .lean();
    const inTransitMap = new Map<string, number>();
    for (const transfer of inTransitTransfers) {
      const key = String(transfer.toBranchId);
      const units = (transfer.items ?? []).reduce(
        (sum, item) => sum + Math.max(0, item.quantity - (item.receivedQuantity ?? 0)),
        0
      );
      inTransitMap.set(key, (inTransitMap.get(key) ?? 0) + units);
    }

    const branchMap = new Map(branches.map((b) => [String(b._id), b]));
    const rows = stockRows
      .map((row) => {
        const product = productMap.get(String(row._id.productId));
        const branch = branchMap.get(String(row._id.branchId));
        if (!product) return null;
        return {
          productId: String(row._id.productId),
          name: product.name,
          sku: product.sku ?? "",
          branchId: row._id.branchId ? String(row._id.branchId) : null,
          branchName: branch?.name ?? "Unassigned",
          branchType: branch?.type ?? "shop",
          stock: row.stock ?? 0,
          reorderPoint: product.reorderPoint ?? 0,
          stockValue: Math.round((row.stock ?? 0) * (product.costPrice ?? 0) * 100) / 100,
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .filter((row) => includeZero || row.stock !== 0);

    const inTransitRows = [...inTransitMap.entries()]
      .map(([toBranchId, units]) => ({
        branchId: toBranchId,
        branchName: branchMap.get(toBranchId)?.name ?? "Unknown location",
        units,
      }))
      .filter((row) => (branchId ? row.branchId === String(branchId) : true));

    const lowStock = rows.filter((row) => row.reorderPoint > 0 && row.stock <= row.reorderPoint && row.stock > 0);
    const outOfStock = rows.filter((row) => row.stock <= 0);
    const summary = {
      locations: branches.length,
      products: products.length,
      totalUnits: rows.reduce((sum, row) => sum + row.stock, 0),
      totalValue: Math.round(rows.reduce((sum, row) => sum + row.stockValue, 0) * 100) / 100,
      inTransitUnits: inTransitRows.reduce((sum, row) => sum + row.units, 0),
      lowStock: lowStock.length,
      outOfStock: outOfStock.length,
    };

    if (format === "csv") {
      return csvResponse("stock-by-location.csv", [
        ["Product", "SKU", "Location", "Type", "Stock", "Reorder point", "Stock value"],
        ...rows.map((row) => [
          row.name,
          row.sku,
          row.branchName,
          row.branchType,
          row.stock,
          row.reorderPoint,
          row.stockValue,
        ]),
      ]);
    }

    return NextResponse.json({
      rows,
      inTransit: inTransitRows,
      summary,
      branches: branches.map((b) => ({ _id: String(b._id), name: b.name, type: b.type ?? "shop" })),
      scope: { branchId: branchId ? String(branchId) : null },
    });
  } catch (error) {
    console.error("GET /api/reports/locations error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
