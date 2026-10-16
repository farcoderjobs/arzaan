import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Sale, Customer } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, notFound, success } from "@/lib/api";
import mongoose from "mongoose";

/** Lists held sales for the current cashier (optionally all cashiers with sales.view). */
export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.create))) {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const mine = searchParams.get("mine") !== "0";
    const canViewAll = await hasPermission(user, PERMISSIONS.sales.view);

    const query: Record<string, unknown> = { status: "held" };
    if (mine || !canViewAll) query.cashierId = new mongoose.Types.ObjectId(user.id);

    const held = await Sale.find(query)
      .sort({ heldAt: -1 })
      .limit(50)
      .populate<{ customerId: { _id: mongoose.Types.ObjectId; name: string } | null }>("customerId", "name")
      .lean();

    return NextResponse.json({
      heldSales: held.map((s) => ({
        _id: s._id.toString(),
        invoiceNumber: s.invoiceNumber,
        customerName: s.customerId ? (s.customerId as { name: string }).name : null,
        itemCount: s.items.reduce((sum, i) => sum + i.quantity, 0),
        total: s.total,
        heldAt: s.heldAt,
        cashierId: s.cashierId.toString(),
      })),
    });
  } catch (error) {
    console.error("GET /api/pos/held-sales error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/**
 * Resumes a held sale: returns its full cart payload and deletes the held document
 * (it becomes an in-progress cart again; completing re-creates a fresh invoice).
 */
export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.create))) {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    }

    const body = await req.json();
    const { id } = body as { id?: string };
    if (!id) return NextResponse.json(badRequest("Held sale ID is required"), { status: 400 });

    const held = await Sale.findOne({ _id: id, status: "held" }).populate<{ customerId: { name: string } | null }>("customerId", "name");
    if (!held) return NextResponse.json(notFound("Held sale not found"), { status: 404 });

    const cart = {
      customerId: held.customerId ? (held.customerId as unknown as { _id: string })._id.toString() : null,
      customerName: held.customerId ? (held.customerId as unknown as { name: string }).name : null,
      items: held.items.map((i) => ({
        productId: i.productId.toString(),
        name: i.name,
        sku: i.sku,
        quantity: i.quantity,
        unitDiscount: i.discount,
      })),
      discount: held.discount,
      discountType: held.discountType,
      note: held.note,
    };

    await Sale.deleteOne({ _id: held._id });

    return NextResponse.json(success({ cart }));
  } catch (error) {
    console.error("POST /api/pos/held-sales error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
