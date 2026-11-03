import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Product, Category, InventoryMovement } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasAnyPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import mongoose from "mongoose";
import { getProductBatches } from "@/lib/inventory-batches";
import { expiredQuantity, sellableQuantity } from "@/lib/expiry";

/**
 * POS product lookup — optimized for barcode scanners and fast search.
 * - ?barcode=... → exact barcode/SKU hit returns a single product (scanner flow)
 * - ?search=...&categoryId=... → paginated grid results
 * Stock is derived from inventory movements (source of truth), branch-scoped.
 */

const STOCK_IN_TYPES = ["PURCHASE_IN", "CUSTOMER_RETURN_IN", "ADJUSTMENT_IN", "STOCK_COUNT_IN", "TRANSFER_IN"];

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasAnyPermission(user, [PERMISSIONS.products.view, PERMISSIONS.sales.create]))) {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const barcode = searchParams.get("barcode")?.trim() ?? "";
    const search = searchParams.get("search")?.trim() ?? "";
    const categoryId = searchParams.get("categoryId")?.trim() ?? "";
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("perPage") ?? 24)));

    // --- Scanner flow: exact barcode or SKU match, returns single product ---
    if (barcode) {
      const escaped = barcode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // One barcode = one sellable product/variant: match the primary barcode,
      // any extra barcode, or an exact SKU.
      const product = await Product.findOne({
        status: "active",
        $or: [
          { barcode: new RegExp(`^${escaped}$`, "i") },
          { "barcodes.code": new RegExp(`^${escaped}$`, "i") },
          { sku: new RegExp(`^${escaped}$`, "i") },
        ],
      })
        .select("name sku barcode barcodes expirationDate variantName sellingPrice discountPrice taxRate costPrice categoryId")
        .lean();

      if (!product) {
        return NextResponse.json({ product: null });
      }
      const stock = await getStock(product._id.toString(), user.branchId);
      const batches = await getProductBatches([product._id.toString()], user.branchId);
      const productBatches = batches.get(product._id.toString()) ?? [];
      return NextResponse.json({
        product: {
          ...product,
          currentStock: stock,
          // Expired stock stays in `currentStock` (never silently removed) but
          // is surfaced so the POS can warn before adding it to the cart.
          expiredQty: expiredQuantity(productBatches),
          sellableQty: sellableQuantity(productBatches),
        },
      });
    }

    // --- Grid flow ---
    const query: Record<string, unknown> = { status: "active" };
    if (categoryId) query.categoryId = new mongoose.Types.ObjectId(categoryId);
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { sku: { $regex: escaped, $options: "i" } },
        { barcode: { $regex: escaped, $options: "i" } },
        { "barcodes.code": { $regex: escaped, $options: "i" } },
      ];
    }

    const [total, categories] = await Promise.all([
      Product.countDocuments(query),
      Category.find().sort({ name: 1 }).select("name").lean(),
    ]);

    const products = await Product.aggregate([
      { $match: query },
      { $sort: { name: 1 } },
      { $skip: (page - 1) * perPage },
      { $limit: perPage },
      {
        $lookup: {
          from: "inventorymovements",
          let: { pid: "$_id" },
          as: "movements",
          // Stock is per selling location: without the branch filter a POS at
          // one shop would offer stock that physically sits in the warehouse
          // or another shop, and every checkout would fail the stock check.
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$productId", "$$pid"] },
                ...(user.branchId ? { branchId: new mongoose.Types.ObjectId(user.branchId) } : {}),
              },
            },
            { $project: { movementType: 1, quantity: 1 } },
          ],
        },
      },
      {
        $addFields: {
          currentStock: {
            $sum: {
              $map: {
                input: "$movements",
                as: "m",
                in: {
                  $cond: [
                    { $in: ["$$m.movementType", STOCK_IN_TYPES] },
                    "$$m.quantity",
                    { $multiply: ["$$m.quantity", -1] },
                  ],
                },
              },
            },
          },
        },
      },
      { $project: { movements: 0 } },
    ]);

    return NextResponse.json({
      products,
      categories: categories.map((c) => ({ _id: c._id.toString(), name: c.name })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    console.error("GET /api/pos/products error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

async function getStock(productId: string, branchId: string | null): Promise<number> {
  const match: Record<string, unknown> = { productId: new mongoose.Types.ObjectId(productId) };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);
  const result = await InventoryMovement.aggregate<{ stock: number }>([
    { $match: match },
    {
      $group: {
        _id: null,
        stock: {
          $sum: {
            $cond: [{ $in: ["$movementType", STOCK_IN_TYPES] }, "$quantity", { $multiply: ["$quantity", -1] }],
          },
        },
      },
    },
  ]);
  return result[0]?.stock ?? 0;
}
