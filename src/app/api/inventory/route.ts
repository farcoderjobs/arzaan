import { NextRequest, NextResponse } from "next/server";
import type { InventoryMovementType } from "@/models";
import { connectDB } from "@/lib/mongodb";
import { Product, InventoryMovement, Category, Brand, User } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden } from "@/lib/api";
import mongoose from "mongoose";

/** Movement types that add stock — single source of truth for stock direction. */
const STOCK_IN_TYPES = ["PURCHASE_IN", "CUSTOMER_RETURN_IN", "ADJUSTMENT_IN", "STOCK_COUNT_IN"];

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.inventory.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("perPage") ?? 15)));
    const productFilter = searchParams.get("product")?.trim() ?? "";
    const typeFilter = searchParams.get("type")?.trim() ?? "";
    const fromDate = searchParams.get("from")?.trim() ?? "";
    const toDate = searchParams.get("to")?.trim() ?? "";

    // Build product stock aggregation
    const productPipeline: mongoose.PipelineStage[] = [
      {
        $lookup: {
          from: "categories",
          localField: "categoryId",
          foreignField: "_id",
          as: "categoryId",
        },
      },
      {
        $lookup: {
          from: "brands",
          localField: "brandId",
          foreignField: "_id",
          as: "brandId",
        },
      },
      {
        $project: {
          _id: 1,
          name: 1,
          sku: 1,
          status: 1,
          reorderPoint: 1,
          categoryId: { $arrayElemAt: ["$categoryId", 0] },
          brandId: { $arrayElemAt: ["$brandId", 0] },
        },
      },
    ];

    // Add expression to compute current stock via aggregation on inventory movements
    productPipeline.push({
      $lookup: {
        from: "inventorymovements",
        let: { prodId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$productId", "$$prodId"] } } },
          {
            $group: {
              _id: null,
              // Stock direction must use an explicit movement-type list (the
              // same one as the POS route and sales-service). The previous
              // implementation compared movement types lexicographically
              // ($lte against "SALE_OUT") and negated with the string literal
              // "-$quantity", which $sum silently ignored — every stock figure
              // on this screen was wrong or zero.
              total: {
                $sum: {
                  $cond: [
                    { $in: ["$movementType", STOCK_IN_TYPES] },
                    "$quantity",
                    { $multiply: ["$quantity", -1] },
                  ],
                },
              },
            },
          },
        ],
        as: "stockCalc",
      },
    });

    productPipeline.push({
      $addFields: {
        currentStock: {
          $ifNull: [{ $arrayElemAt: ["$stockCalc.total", 0] }, 0],
        },
      },
    });

    if (productFilter) {
      productPipeline.push({
        $match: {
          $or: [
            { name: { $regex: productFilter, $options: "i" } },
            { sku: { $regex: productFilter, $options: "i" } },
          ],
        },
      });
    }

    productPipeline.push({ $sort: { createdAt: -1 } });
    productPipeline.push({ $skip: (page - 1) * perPage });
    productPipeline.push({ $limit: perPage });

    const products = (await Product.aggregate(productPipeline)) as Array<Record<string, unknown>>;

    // Statistics
    const statsPipeline = productPipeline.slice(0, -3);
    const statsResult = await Product.aggregate([
      ...statsPipeline,
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          lowStock: {
            $sum: {
              $cond: [
                { $and: [{ $gt: ["$currentStock", 0] }, { $lte: ["$currentStock", "$reorderPoint"] }] },
                1,
                0,
              ],
            },
          },
          outOfStock: { $sum: { $cond: [{ $eq: ["$currentStock", 0] }, 1, 0] } },
        },
      },
    ]);
    const stats = (statsResult[0] ?? { totalProducts: 0, lowStock: 0, outOfStock: 0 }) as {
      totalProducts: number;
      lowStock: number;
      outOfStock: number;
    };

    // Movement history
    const movementFilter: Record<string, unknown> = {};
    if (typeFilter) movementFilter.movementType = typeFilter;
    if (fromDate || toDate) {
      const gte = fromDate ? new Date(fromDate) : new Date(0);
      const lte = toDate ? new Date(toDate) : new Date();
      movementFilter.createdAt = { $gte: gte, $lte: lte };
    }

    const movementTotal = await InventoryMovement.countDocuments(movementFilter);
    const movements = await InventoryMovement.find(movementFilter)
      .populate<{ productId: { name: string; sku: string } }>("productId", "name sku")
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean() as Array<Record<string, unknown>>;

    // De-duplicate page for movements vs products; keep separate pagination
    const movementPage = Math.ceil(movementTotal / perPage);

    return NextResponse.json({
      products,
      movements: movements.map((m) => ({
        ...m,
        productId: m.productId as { _id: string; name: string; sku: string } | null,
      })),
      total: movementTotal,
      page,
      perPage,
      totalPages: movementPage,
      stats,
    });
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.inventory.adjust))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = await req.json();
    const { productId, quantity, movementType, reason } = body as {
      productId?: string;
      quantity?: number;
      movementType?: string;
      reason?: string;
    };

    if (!productId || !quantity || !movementType || !reason) {
      return NextResponse.json(badRequest("Product, quantity, type, and reason are required"), { status: 400 });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return NextResponse.json(badRequest("Product not found"), { status: 404 });
    }

    const validTypes = [
      "PURCHASE_IN",
      "SALE_OUT",
      "CUSTOMER_RETURN_IN",
      "SUPPLIER_RETURN_OUT",
      "ADJUSTMENT_IN",
      "ADJUSTMENT_OUT",
      "STOCK_COUNT_IN",
      "STOCK_COUNT_OUT",
    ];
    if (!validTypes.includes(movementType)) {
      return NextResponse.json(badRequest("Invalid movement type"), { status: 400 });
    }

    const movement = await InventoryMovement.create({
      productId,
      branchId: product.branchId ?? null,
      movementType: movementType as InventoryMovementType,
      quantity,
      unitCost: product.costPrice ?? 0,
      referenceType: "adjustment",
      referenceId: null,
      note: reason,
      userId: user.id,
    });

    return NextResponse.json(success({ movement }, "Stock adjusted"), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
