import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { SaleReturn } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, notFound, success } from "@/lib/api";
import { z } from "zod";
import mongoose from "mongoose";
import { createSaleReturn, approveSaleReturn, rejectSaleReturn, ReturnValidationError } from "@/lib/returns-service";
import { getStoreSettings } from "@/lib/settings";
import { recordAuditLog } from "@/lib/audit";

const createSchema = z.object({
  saleId: z.string().min(1, "Original sale is required"),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().min(1).max(10000),
      })
    )
    .min(1, "Select at least one item to return"),
  refundMethod: z.enum(["cash", "original", "credit"]).default("cash"),
  reason: z.string().min(1, "Return reason is required").max(300),
  note: z.string().max(300).default(""),
});

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.refund))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const path = err.path[0];
        if (typeof path === "string") fieldErrors[path] = err.message;
      });
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }

    const data = parsed.data;

    // Manager approval is opt-in via store settings (pos.refund_requires_approval = true)
    const settings = await getStoreSettings(user.branchId);
    const requireApproval = settings.refundRequiresApproval;

    const result = await createSaleReturn({
      saleId: data.saleId,
      userId: user.id,
      items: data.items,
      refundMethod: data.refundMethod,
      reason: data.reason,
      note: data.note,
      requireApproval,
    });

    await recordAuditLog({
      user,
      action: "sale_return.create",
      entityType: "SaleReturn",
      entityId: result.id,
      newValue: { returnNumber: result.returnNumber, total: result.total, status: result.status, refundMethod: data.refundMethod },
      note: `Return for sale ${data.saleId}: ${data.reason}`,
    });

    return NextResponse.json(success(result, requireApproval ? "Return submitted for approval" : "Return processed"), { status: 201 });
  } catch (error) {
    if (error instanceof ReturnValidationError) {
      return NextResponse.json(
        { success: false, error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    console.error("POST /api/sales-returns error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("perPage") ?? 15)));
    const search = searchParams.get("search")?.trim() ?? "";
    const status = searchParams.get("status")?.trim() ?? "";
    const saleId = searchParams.get("saleId")?.trim() ?? "";

    const query: Record<string, unknown> = {};
    if (status) query.status = status;
    if (saleId) query.saleId = new mongoose.Types.ObjectId(saleId);
    if (search) {
      query.$or = [
        { returnNumber: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
      ];
    }

    const total = await SaleReturn.countDocuments(query);
    const returns = await SaleReturn.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .populate<{ userId: { name: string } }>("userId", "name")
      .populate<{ saleId: { _id: unknown; invoiceNumber: string } }>("saleId", "invoiceNumber")
      .populate<{ customerId: { name: string } | null }>("customerId", "name")
      .lean();

    return NextResponse.json({
      returns: returns.map((r) => ({
        _id: r._id.toString(),
        returnNumber: r.returnNumber,
        saleInvoiceNumber: (r.saleId as unknown as { invoiceNumber: string })?.invoiceNumber ?? "",
        saleId: (r.saleId as unknown as { _id: unknown })?._id?.toString?.() ?? null,
        customerName: r.customerId ? (r.customerId as unknown as { name: string }).name : null,
        itemsCount: r.items.reduce((s, i) => s + i.quantity, 0),
        total: r.total,
        refundMethod: r.refundMethod,
        status: r.status,
        reason: r.reason,
        userName: (r.userId as unknown as { name: string })?.name ?? "—",
        createdAt: r.createdAt,
      })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    console.error("GET /api/sales-returns error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Approve or reject a pending return (manager action). */
export async function PUT(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.refund))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = await req.json();
    const { id, action } = body as { id?: string; action?: "approve" | "reject" };
    if (!id || !action) {
      return NextResponse.json(badRequest("Return ID and action are required"), { status: 400 });
    }

    const result =
      action === "approve"
        ? await approveSaleReturn(id, user.id)
        : await rejectSaleReturn(id, user.id);

    await recordAuditLog({
      user,
      action: `sale_return.${action}`,
      entityType: "SaleReturn",
      entityId: id,
      newValue: result,
    });

    return NextResponse.json(success(result, action === "approve" ? "Return approved" : "Return rejected"));
  } catch (error) {
    if (error instanceof ReturnValidationError) {
      return NextResponse.json(
        { success: false, error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    console.error("PUT /api/sales-returns error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest) {
  return NextResponse.json(notFound("Returns cannot be deleted"), { status: 404 });
}
