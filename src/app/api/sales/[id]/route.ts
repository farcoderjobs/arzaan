import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Sale, SaleReturn, Customer, User } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission, hasAnyPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { notFound, success, badRequest, forbidden } from "@/lib/api";
import { recordAuditLog, requestMeta, diffForAudit } from "@/lib/audit";
import { assertBranchAccess, BranchAccessError } from "@/lib/branch-access";
import mongoose from "mongoose";

/**
 * Sale detail API. Internal cost prices are only exposed to users with
 * reports.profit — the customer-facing receipt never includes them.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasAnyPermission(user, [PERMISSIONS.sales.view, PERMISSIONS.sales.create]))) {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    }

    const { id } = await params;

    const sale = await Sale.findById(id)
      .populate<{ customerId: { _id: unknown; name: string; phone?: string } | null }>("customerId", "name phone")
      .populate<{ cashierId: { _id: unknown; name: string } }>("cashierId", "name")
      .populate<{ branchId: { name: string; address: string; phone: string; currency: string } | null }>("branchId", "name address phone currency")
      .lean();

    if (!sale) {
      return NextResponse.json(notFound("Sale not found"), { status: 404 });
    }

    // Branch-restricted users cannot read sales from other branches.
    assertBranchAccess(user, (sale as { branchId?: mongoose.Types.ObjectId | null }).branchId);

    const returns = await SaleReturn.find({ saleId: id })
      .sort({ createdAt: -1 })
      .populate<{ userId: { _id: unknown; name: string } }>("userId", "name")
      .populate<{ approvedBy: { _id: unknown; name: string } | null }>("approvedBy", "name")
      .lean();

    const canSeeCost = await hasPermission(user, PERMISSIONS.reports.profit);

    const saleBranchId = (sale.branchId as { _id?: mongoose.Types.ObjectId } | null)?. _id ?? null;
    const res = {
      sale: {
        ...sale,
        customerId: sale.customerId
          ? {
              _id: (sale.customerId as unknown as { _id: string })._id?.toString?.() ?? null,
              name: sale.customerId.name,
              phone: sale.customerId.phone ?? "",
            }
          : null,
        cashierName: (sale.cashierId as unknown as { name: string })?.name ?? "—",
        branchName: sale.branchId?.name ?? "",
        branchAddress: sale.branchId?.address ?? "",
        branchPhone: sale.branchId?.phone ?? "",
        items: sale.items.map((item) => ({
          productId: item.productId.toString(),
          name: item.name,
          sku: item.sku,
          quantity: item.quantity,
          sellingPrice: item.sellingPrice,
          discount: item.discount,
          tax: item.tax,
          subtotal: item.subtotal,
          ...(canSeeCost ? { costPrice: item.costPrice } : {}),
        })),
      },
      returns: returns.map((r) => ({
        _id: r._id.toString(),
        returnNumber: r.returnNumber,
        status: r.status,
        items: r.items.map((i) => ({
          productId: i.productId.toString(),
          name: i.name,
          sku: i.sku,
          quantity: i.quantity,
          sellingPrice: i.sellingPrice,
          subtotal: i.subtotal,
        })),
        total: r.total,
        refundMethod: r.refundMethod,
        reason: r.reason,
        userName: (r.userId as unknown as { name: string })?.name ?? "—",
        approvedByName: r.approvedBy ? (r.approvedBy as unknown as { name: string }).name : null,
        createdAt: r.createdAt,
      })),
      canSeeCost,
    };

    // Emit an access audit entry so we know who viewed the sale detail (read of
    // sensitive financial record, not just navigation).
    await recordAuditLog({
      user,
      action: "sale.viewed",
      entityType: "sale",
      entityId: id,
      branchId: saleBranchId?.toString() ?? null,
      note: "Sale detail viewed",
      ...requestMeta(_req),
    });

    return NextResponse.json(res);
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("GET /api/sales/[id] error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
