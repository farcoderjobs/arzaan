import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Warehouse } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasAnyPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, notFound } from "@/lib/api";
import { listWarehouseInventory } from "@/lib/warehouse-stock";

/**
 * GET /api/warehouses/inventory?warehouseId=…&search=…
 *
 * The stock a warehouse currently holds, with quantity and inventory value.
 * Quantities come from the movement ledger, so they always match what was
 * transferred in minus what was transferred out.
 */
export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasAnyPermission(user, [PERMISSIONS.inventory.view, PERMISSIONS.transfers.view]))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const warehouseId = searchParams.get("warehouseId")?.trim() ?? "";
    const search = searchParams.get("search")?.trim() ?? "";
    if (!mongoose.Types.ObjectId.isValid(warehouseId)) {
      return NextResponse.json(badRequest("Select a warehouse"), { status: 400 });
    }

    const warehouse = await Warehouse.findById(warehouseId).lean();
    if (!warehouse) return NextResponse.json(notFound("Warehouse not found"), { status: 404 });

    const items = await listWarehouseInventory({ warehouseId, search });
    return NextResponse.json({
      warehouse: {
        _id: String(warehouse._id),
        name: warehouse.name,
        code: warehouse.code,
        status: warehouse.status,
      },
      items,
      totalUnits: items.reduce((sum, item) => sum + item.quantity, 0),
      totalValue: items.reduce((sum, item) => sum + item.value, 0),
    });
  } catch (error) {
    console.error("GET /api/warehouses/inventory error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
