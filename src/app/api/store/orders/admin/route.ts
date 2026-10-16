import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { StoreOrder, StoreProduct } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { parsePage } from "@/lib/reports";

/**
 * Admin management of online store orders (/store-orders in the dashboard).
 * Statuses: pending → confirmed → shipped → delivered (or canceled).
 * Canceling an order puts the units back on the product's stock.
 */

const STATUS_FLOW: Record<string, string[]> = {
  pending: ["confirmed", "canceled"],
  confirmed: ["shipped", "canceled"],
  shipped: ["delivered"],
  delivered: [],
  canceled: [],
};

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.store.orders))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const { page, perPage } = parsePage(searchParams);
    const status = searchParams.get("status")?.trim() ?? "";
    const search = searchParams.get("search")?.trim() ?? "";

    const query: Record<string, unknown> = {};
    if (["pending", "confirmed", "shipped", "delivered", "canceled"].includes(status)) {
      query.status = status;
    }
    if (search) {
      const or: Array<Record<string, unknown>> = [
        { orderNumber: { $regex: search, $options: "i" } },
        { customerName: { $regex: search, $options: "i" } },
        { phone: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
      ];
      if (mongoose.Types.ObjectId.isValid(search)) or.push({ _id: new mongoose.Types.ObjectId(search) });
      query.$or = or;
    }

    const total = await StoreOrder.countDocuments(query);
    const orders = await StoreOrder.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean();

    return NextResponse.json({
      orders: orders.map((o) => ({ ...o, id: o._id.toString() })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    console.error("GET /api/store/orders admin error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.store.orders))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const schema = z.object({
      id: z.string().min(1),
      status: z.enum(["pending", "confirmed", "shipped", "delivered", "canceled"]),
      note: z.string().trim().max(400).optional(),
    });
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(badRequest("Invalid order update"), { status: 400 });
    }

    const order = await StoreOrder.findById(parsed.data.id);
    if (!order) {
      return NextResponse.json(notFound("Order not found"), { status: 404 });
    }

    const allowed = STATUS_FLOW[order.status] ?? [];
    if (order.status === parsed.data.status) {
      return NextResponse.json(success({ order }, "Order unchanged"));
    }
    if (!allowed.includes(parsed.data.status)) {
      return NextResponse.json(
        badRequest(`Cannot move an order from "${order.status}" to "${parsed.data.status}"`),
        { status: 400 }
      );
    }

    // Restock on cancellation so the units go back on the storefront.
    if (parsed.data.status === "canceled") {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          for (const item of order.items) {
            await StoreProduct.updateOne(
              { _id: item.productId },
              { $inc: { stock: item.quantity } },
              { session }
            );
          }
          order.status = "canceled";
          if (parsed.data.note) order.note = parsed.data.note.slice(0, 400);
          await order.save({ session });
        });
      } finally {
        await session.endSession();
      }
    } else {
      order.status = parsed.data.status;
      await order.save();
    }

    await recordAuditLog({
      user,
      action: "store.order.status_changed",
      entityType: "StoreOrder",
      entityId: order._id,
      oldValue: undefined,
      changes: { status: { after: parsed.data.status } },
      note: `${order.orderNumber}${parsed.data.note ? ` — ${parsed.data.note}` : ""}`,
      ...requestMeta(req),
    });

    return NextResponse.json(success({ order }, `Order marked ${parsed.data.status}`));
  } catch (error) {
    console.error("PATCH /api/store/orders admin error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
