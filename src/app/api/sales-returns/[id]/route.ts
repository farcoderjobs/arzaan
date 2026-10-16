import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { SaleReturn } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { notFound } from "@/lib/api";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.view))) {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    }

    const { id } = await params;
    const saleReturn = await SaleReturn.findById(id)
      .populate<{ saleId: { _id: unknown; invoiceNumber: string } }>("saleId", "invoiceNumber")
      .populate<{ userId: { name: string } }>("userId", "name")
      .populate<{ approvedBy: { name: string } | null }>("approvedBy", "name")
      .populate<{ customerId: { _id: unknown; name: string } | null }>("customerId", "name")
      .lean();

    if (!saleReturn) {
      return NextResponse.json(notFound("Return not found"), { status: 404 });
    }

    return NextResponse.json({
      return: {
        ...saleReturn,
        saleId: (saleReturn.saleId as unknown as { _id: unknown })?._id?.toString?.() ?? null,
        saleInvoiceNumber: (saleReturn.saleId as unknown as { invoiceNumber: string })?.invoiceNumber ?? "",
        items: saleReturn.items.map((i) => ({
          productId: i.productId.toString(),
          name: i.name,
          sku: i.sku,
          quantity: i.quantity,
          sellingPrice: i.sellingPrice,
          subtotal: i.subtotal,
        })),
        userName: (saleReturn.userId as unknown as { name: string })?.name ?? "—",
        approvedByName: saleReturn.approvedBy ? (saleReturn.approvedBy as unknown as { name: string }).name : null,
        customerId: saleReturn.customerId
          ? {
              _id: (saleReturn.customerId as unknown as { _id: unknown })?._id?.toString?.() ?? null,
              name: (saleReturn.customerId as unknown as { name: string }).name,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("GET /api/sales-returns/[id] error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
