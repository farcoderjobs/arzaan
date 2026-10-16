import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Sale, Customer } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden } from "@/lib/api";
import { z } from "zod";
import mongoose from "mongoose";
import { completeSale, SaleValidationError } from "@/lib/sales-service";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { getStoreSettings } from "@/lib/settings";

/**
 * Sales API.
 *
 * POST /api/sales — completes (or holds) a sale. ALL totals are recalculated
 * server-side from product data: client amounts are advisory only.
 */
const checkoutSchema = z.object({
  /** Client-generated idempotency key (offline-first POS) — same semantics as /api/sync/sale. */
  clientTransactionId: z.string().min(8).max(100).optional(),
  customerId: z.string().nullable().default(null),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().min(1).max(10000),
        unitDiscount: z.number().min(0).default(0),
      })
    )
    .min(1, "At least one item is required"),
  discount: z.number().min(0).default(0),
  discountType: z.enum(["amount", "percent"]).default("amount"),
  payments: z
    .array(
      z.object({
        method: z.enum(["cash", "card", "transfer", "credit"]),
        amount: z.number().positive(),
        reference: z.string().max(200).default(""),
      })
    )
    .default([]),
  note: z.string().max(500).default(""),
  status: z.enum(["completed", "held"]).default("completed"),
});

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.create))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = checkoutSchema.safeParse(await req.json());
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const path = err.path[0];
        if (typeof path === "string") fieldErrors[path] = err.message;
      });
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }

    const data = parsed.data;

    // Discounts require an explicit permission. Cashiers without it cannot
    // discount a line or the whole sale, even by calling the API directly.
    if (!(await hasPermission(user, PERMISSIONS.sales.discount))) {
      const hasLineDiscount = data.items.some((i) => i.unitDiscount > 0);
      if (data.discount > 0 || hasLineDiscount) {
        return NextResponse.json(
          forbidden("You do not have permission to apply discounts"),
          { status: 403 }
        );
      }
    }

    // Idempotent replay: the offline-first client retries with the same
    // clientTransactionId — return the sale that already exists.
    if (data.clientTransactionId) {
      const existing = await Sale.findOne({ clientTransactionId: data.clientTransactionId }).lean();
      if (existing) {
        return NextResponse.json(
          {
            success: true,
            alreadySynced: true,
            data: {
              id: existing._id.toString(),
              invoiceNumber: existing.invoiceNumber,
              total: existing.total,
              paidAmount: existing.paidAmount,
              changeAmount: existing.changeAmount,
              status: existing.status,
              creditUsed: 0,
            },
            message: "Sale already processed",
          },
          { status: 200 }
        );
      }
    }

    const meta = requestMeta(req);
    const settings = await getStoreSettings(user.branchId);

    if (data.customerId) {
      const customer = await Customer.findById(data.customerId);
      if (!customer || customer.status !== "active") {
        return NextResponse.json(badRequest("Selected customer not found or inactive"), { status: 400 });
      }
    }

    // Settings enforcement: credit sales require a customer
    if (!data.customerId && settings.requireCustomerForCredit && data.payments.some((p) => p.method === "credit")) {
      return NextResponse.json(badRequest("Credit sales require a selected customer"), { status: 400 });
    }

    // Settings enforcement: cashiers cannot exceed the configured maximum percent discount
    if (data.discountType === "percent" && data.discount > settings.maxCashierDiscountPercent) {
      return NextResponse.json(
        badRequest(`Discount ${data.discount}% exceeds the maximum allowed (${settings.maxCashierDiscountPercent}%)`),
        { status: 400 }
      );
    }

    // Merge duplicate product lines so stock math is correct
    const merged = new Map<string, { quantity: number; unitDiscount: number }>();
    for (const item of data.items) {
      const existing = merged.get(item.productId);
      if (existing) {
        existing.quantity += item.quantity;
        existing.unitDiscount += item.unitDiscount;
      } else {
        merged.set(item.productId, { quantity: item.quantity, unitDiscount: item.unitDiscount });
      }
    }

    const result = await completeSale({
      branchId: user.branchId,
      customerId: data.customerId,
      cashierId: user.id,
      items: [...merged.entries()].map(([productId, v]) => ({ productId, ...v })),
      discount: data.discount,
      discountType: data.discountType,
      payments: data.payments,
      note: data.note,
      status: data.status,
      clientTransactionId: data.clientTransactionId ?? null,
    });

    await recordAuditLog({
      user,
      action: data.status === "held" ? "sale.hold" : "sale.create",
      entityType: "Sale",
      entityId: result.id,
      newValue: { invoiceNumber: result.invoiceNumber, total: result.total, paidAmount: result.paidAmount, creditUsed: result.creditUsed },
      ...meta,
    });

    return NextResponse.json(
      {
        success: true,
        data: result,
        message: data.status === "held" ? "Sale held" : "Sale completed",
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof SaleValidationError) {
      return NextResponse.json(
        { success: false, error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    console.error("POST /api/sales error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/**
 * GET /api/sales — paginated list with server-side filters.
 * Filters: from/to dates, customerId, cashierId, paymentMethod, status, invoice search.
 */
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
    const customerId = searchParams.get("customerId")?.trim() ?? "";
    const cashierId = searchParams.get("cashierId")?.trim() ?? "";
    const paymentMethod = searchParams.get("paymentMethod")?.trim() ?? "";
    const status = searchParams.get("status")?.trim() ?? "";
    const from = searchParams.get("from")?.trim() ?? "";
    const to = searchParams.get("to")?.trim() ?? "";

    const query: Record<string, unknown> = {};
    if (status) query.status = status;
    if (customerId) query.customerId = new mongoose.Types.ObjectId(customerId);
    if (cashierId) query.cashierId = new mongoose.Types.ObjectId(cashierId);
    if (paymentMethod) query.paymentMethod = paymentMethod;
    if (search) {
      query.invoiceNumber = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    }
    if (from || to) {
      query.createdAt = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(`${to}T23:59:59.999Z`) } : {}),
      };
    }

    // Branch isolation: branch-restricted users only see their branch's sales
    if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);

    // Non-privileged cashiers only see their own sales
    const canViewAll = await hasPermission(user, PERMISSIONS.sales.view);
    if (canViewAll === false) query.cashierId = new mongoose.Types.ObjectId(user.id);

    const total = await Sale.countDocuments(query);
    const sales = await Sale.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .populate<{ customerId: { _id: mongoose.Types.ObjectId; name: string } | null }>("customerId", "name")
      .populate<{ cashierId: { _id: mongoose.Types.ObjectId; name: string } }>("cashierId", "name")
      .lean();

    return NextResponse.json({
      sales: sales.map((s) => ({
        _id: s._id.toString(),
        invoiceNumber: s.invoiceNumber,
        createdAt: s.createdAt,
        customerName: s.customerId ? (s.customerId as { name: string }).name : null,
        cashierName: (s.cashierId as unknown as { name: string })?.name ?? "—",
        total: s.total,
        paymentMethod: s.paymentMethod,
        status: s.status,
        itemCount: s.items.reduce((sum, i) => sum + i.quantity, 0),
      })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    console.error("GET /api/sales error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
