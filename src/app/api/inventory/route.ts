import { NextRequest, NextResponse } from "next/server";
import type { InventoryMovementType } from "@/models";
import { connectDB } from "@/lib/mongodb";
import { Product, InventoryMovement, Category, Brand, User, Branch, Warehouse } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden } from "@/lib/api";
import mongoose from "mongoose";
import { batchStockStages, STOCK_IN_TYPES } from "@/lib/expiry";

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
    const productPage = Math.max(1, Number(searchParams.get("productPage") ?? 1));
    const productPerPage = Math.min(100, Math.max(1, Number(searchParams.get("productPerPage") ?? 15)));
    const productFilter = searchParams.get("product")?.trim() ?? "";
    const stockStatus = searchParams.get("stockStatus")?.trim() ?? "";
    const expiryFilter = searchParams.get("expiry")?.trim() ?? "";
    const typeFilter = searchParams.get("type")?.trim() ?? "";
    const fromDate = searchParams.get("from")?.trim() ?? "";
    const toDate = searchParams.get("to")?.trim() ?? "";
    // Optional location filter ("" = every location: shops and warehouses).
    // Warehouse locations arrive prefixed ("warehouse:<id>") because they are a
    // separate entity from branches, not another branch row.
    const rawLocation = searchParams.get("location")?.trim() ?? "";
    const isWarehouseLocation = rawLocation.startsWith("warehouse:");
    const locationId = isWarehouseLocation ? rawLocation.slice("warehouse:".length) : rawLocation;
    const locationObjectId =
      locationId && mongoose.Types.ObjectId.isValid(locationId)
        ? new mongoose.Types.ObjectId(locationId)
        : null;

    // Stock is shown for EVERY location by default — a shop user must be able to
    // see what the warehouse holds (and vice versa). Selecting a location scopes
    // the quantity column, it does not hide the other locations from the list.
    const branchObjectId = isWarehouseLocation ? null : locationObjectId;
    const warehouseObjectId = isWarehouseLocation ? locationObjectId : null;
    const now = new Date();

    /**
     * Product stock pipeline. Stock AND per-batch expiry both come from the
     * movement ledger (`batchStockStages`), so expired stock keeps counting in
     * stock totals while still being reported separately.
     */
    const basePipeline: mongoose.PipelineStage[] = [
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
      ...batchStockStages({ now, branchId: branchObjectId, warehouseId: warehouseObjectId }),
      // Per-location quantities, so one row shows the stock in every place.
      {
        $lookup: {
          from: "inventorymovements",
          let: { pid: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$productId", "$$pid"] } } },
            {
              $group: {
                // A location is a branch OR a warehouse, so both are keyed.
                _id: { branchId: "$branchId", warehouseId: "$warehouseId" },
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
          ],
          as: "stockByLocation",
        },
      },
      {
        $project: {
          _id: 1,
          name: 1,
          sku: 1,
          barcode: 1,
          status: 1,
          reorderPoint: 1,
          sellingPrice: 1,
          costPrice: 1,
          expirationDate: 1,
          variantName: 1,
          createdAt: 1,
          currentStock: 1,
          stockByLocation: 1,
          expiredQty: 1,
          expiringQty: 1,
          earliestExpiration: 1,
          categoryId: { $arrayElemAt: ["$categoryId", 0] },
          brandId: { $arrayElemAt: ["$brandId", 0] },
        },
      },
    ];

    if (productFilter) {
      const rx = new RegExp(productFilter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      basePipeline.push({
        $match: { $or: [{ name: rx }, { sku: rx }, { barcode: rx }] },
      });
    }

    if (locationObjectId) {
      basePipeline.push({
        $match: {
          stockByLocation: {
            $elemMatch: warehouseObjectId
              ? { "_id.warehouseId": warehouseObjectId, quantity: { $gt: 0 } }
              : { "_id.branchId": locationObjectId, quantity: { $gt: 0 } },
          },
        },
      });
    }

    // Status filters are applied to the list only — the stat cards stay global
    // so clicking an indicator does not make its own count disappear.
    const statusFilters: mongoose.PipelineStage[] = [];
    if (stockStatus === "low") {
      statusFilters.push({
        $match: {
          $expr: {
            $and: [
              { $gt: ["$currentStock", 0] },
              { $lte: ["$currentStock", "$reorderPoint"] },
            ],
          },
        },
      });
    } else if (stockStatus === "out") {
      statusFilters.push({ $match: { $expr: { $lte: ["$currentStock", 0] } } });
    }
    if (expiryFilter === "expired") {
      statusFilters.push({ $match: { $expr: { $gt: ["$expiredQty", 0] } } });
    } else if (expiryFilter === "expiring") {
      statusFilters.push({ $match: { $expr: { $gt: ["$expiringQty", 0] } } });
    } else if (expiryFilter === "all") {
      statusFilters.push({
        $match: { $expr: { $or: [{ $gt: ["$expiredQty", 0] }, { $gt: ["$expiringQty", 0] }] } },
      });
    }

    const filteredCount = await Product.aggregate([
      ...basePipeline,
      ...statusFilters,
      { $count: "total" },
    ]);
    const productTotal = (filteredCount[0]?.total as number | undefined) ?? 0;

    const products = (await Product.aggregate([
      ...basePipeline,
      ...statusFilters,
      { $sort: { createdAt: -1 } },
      { $skip: (productPage - 1) * productPerPage },
      { $limit: productPerPage },
    ])) as Array<Record<string, unknown>>;

    // Statistics (search scope, unaffected by the stock/expiry status filter)
    const statsResult = await Product.aggregate([
      ...basePipeline,
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
          outOfStock: { $sum: { $cond: [{ $lte: ["$currentStock", 0] }, 1, 0] } },
          expired: { $sum: { $cond: [{ $gt: ["$expiredQty", 0] }, 1, 0] } },
          expiring: { $sum: { $cond: [{ $gt: ["$expiringQty", 0] }, 1, 0] } },
        },
      },
    ]);
    const stats = (statsResult[0] ?? {
      totalProducts: 0,
      lowStock: 0,
      outOfStock: 0,
      expired: 0,
      expiring: 0,
    }) as {
      totalProducts: number;
      lowStock: number;
      outOfStock: number;
      expired: number;
      expiring: number;
    };

    // Movement history — every location, unless one is selected.
    const movementFilter: Record<string, unknown> = {};
    if (typeFilter) movementFilter.movementType = typeFilter;
    if (warehouseObjectId) movementFilter.warehouseId = warehouseObjectId;
    else if (locationObjectId) movementFilter.branchId = locationObjectId;
    if (fromDate || toDate) {
      const gte = fromDate ? new Date(fromDate) : new Date(0);
      const lte = toDate ? new Date(toDate) : new Date();
      movementFilter.createdAt = { $gte: gte, $lte: lte };
    }

    const movementTotal = await InventoryMovement.countDocuments(movementFilter);
    const movements = await InventoryMovement.find(movementFilter)
      .populate<{ productId: { name: string; sku: string } }>("productId", "name sku")
      .populate<{ branchId: { name: string } }>("branchId", "name")
      .populate<{ warehouseId: { name: string } }>("warehouseId", "name")
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean() as Array<Record<string, unknown>>;

    // De-duplicate page for movements vs products; keep separate pagination
    const movementPage = Math.ceil(movementTotal / perPage);

    // Every stock location (shops and warehouses) for the location filter.
    const branches = await Branch.find({})
      .select("name code type status")
      .sort({ name: 1 })
      .lean();
    const warehouses = await Warehouse.find({})
      .select("name code status")
      .sort({ name: 1 })
      .lean();
    const branchNameById = new Map(branches.map((b) => [String(b._id), b.name]));
    const warehouseNameById = new Map(warehouses.map((w) => [String(w._id), w.name]));

    return NextResponse.json({
      products: (products as Array<Record<string, unknown>>).map((p) => {
        const byLocation = (p.stockByLocation ?? []) as Array<{
          _id: { branchId: unknown; warehouseId: unknown };
          quantity: number;
        }>;
        return {
          ...p,
          stockByLocation: byLocation
            .filter((row) => (row.quantity ?? 0) !== 0)
            .map((row) => {
              const warehouseId = row._id?.warehouseId ? String(row._id.warehouseId) : null;
              const branchId = row._id?.branchId ? String(row._id.branchId) : null;
              return {
                id: warehouseId ? `warehouse:${warehouseId}` : branchId ?? "unassigned",
                branchId,
                warehouseId,
                name: warehouseId
                  ? warehouseNameById.get(warehouseId) ?? "Warehouse"
                  : branchId
                    ? branchNameById.get(branchId) ?? "Unassigned"
                    : "Unassigned",
                type: warehouseId ? "warehouse" : "shop",
                quantity: row.quantity ?? 0,
              };
            }),
        };
      }),
      locations: [
        ...branches.map((b) => ({
          _id: String(b._id),
          name: b.name,
          type: b.type ?? "shop",
          status: b.status,
        })),
        ...warehouses.map((w) => ({
          _id: `warehouse:${String(w._id)}`,
          name: w.name,
          type: "warehouse",
          status: w.status,
        })),
      ],
      productTotal,
      productPage,
      productPerPage,
      productTotalPages: Math.ceil(productTotal / productPerPage),
      movements: movements.map((m) => ({
        ...m,
        productId: m.productId as { _id: string; name: string; sku: string } | null,
        locationName:
          m.warehouseId && typeof m.warehouseId === "object"
            ? ((m.warehouseId as { name?: string }).name ?? "Warehouse")
            : m.branchId && typeof m.branchId === "object"
              ? ((m.branchId as { name?: string }).name ?? "—")
              : "Unassigned",
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
    const { productId, quantity, movementType, reason, branchId } = body as {
      productId?: string;
      quantity?: number;
      movementType?: string;
      reason?: string;
      /** Location the adjustment applies to (defaults to the product's own). */
      branchId?: string | null;
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
      "TRANSFER_IN",
      "TRANSFER_OUT",
    ];
    if (!validTypes.includes(movementType)) {
      return NextResponse.json(badRequest("Invalid movement type"), { status: 400 });
    }

    let movementBranchId: mongoose.Types.ObjectId | null = product.branchId ?? null;
    if (branchId) {
      if (!mongoose.Types.ObjectId.isValid(branchId)) {
        return NextResponse.json(badRequest("Invalid location"), { status: 400 });
      }
      const branch = await Branch.findById(branchId).select("_id").lean();
      if (!branch) {
        return NextResponse.json(badRequest("Location not found"), { status: 400 });
      }
      movementBranchId = new mongoose.Types.ObjectId(branchId);
    } else if (!movementBranchId && user.branchId) {
      movementBranchId = new mongoose.Types.ObjectId(user.branchId);
    }

    const movement = await InventoryMovement.create({
      productId,
      branchId: movementBranchId,
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
