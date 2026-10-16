import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Sale, Customer } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden } from "@/lib/api";
import { z } from "zod";
import { completeSale, SaleValidationError } from "@/lib/sales-service";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { getStoreSettings } from "@/lib/settings";

/**
 * POST /api/sync/sale — idempotent ingestion of offline-captured sales.
 *
 * The client generates `clientTransactionId` (UUID) while offline and retries
 * freely. The server guarantees at-most-once processing:
 *   1. Pre-check: a sale with this id already exists → return it (200).
 *   2. Race: completeSale runs inside a MongoDB transaction; the unique
 *      partial index on clientTransactionId rejects a concurrent duplicate
 *      (E11000) → we re-read and return the existing sale.
 *
 * Everything else mirrors POST /api/sales: totals are recalculated server-side,
 * stock conflicts surface as explicit errors (never silently accepted).
 */
const syncSaleSchema = z.object({
  clientTransactionId: z.string().min(8).max(100),
  deviceId: z.string().max(100).optional(),
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

function existingSaleResponse(sale: {
  _id: { toString(): string } | string;
  invoiceNumber: string;
  total: number;
  paidAmount: number;
  changeAmount: number;
  status: string;
}) {
  return NextResponse.json(
    {
      success: true,
      alreadySynced: true,
      data: {
        id: sale._id.toString(),
        invoiceNumber: sale.invoiceNumber,
        total: sale.total,
        paidAmount: sale.paidAmount,
        changeAmount: sale.changeAmount,
        status: sale.status,
        creditUsed: 0,
      },
      message: "Sale already synced",
    },
    { status: 200 }
  );
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.create))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = syncSaleSchema.safeParse(await req.json());
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const path = err.path[0];
        if (typeof path === "string") fieldErrors[path] = err.message;
      });
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }

    const data = parsed.data;

    // Discounts require an explicit permission. A queued offline sale replayed
    // by a cashier without it must not carry discounts through the sync path.
    if (!(await hasPermission(user, PERMISSIONS.sales.discount))) {
      const hasLineDiscount = data.items.some((i) => i.unitDiscount > 0);
      if (data.discount > 0 || hasLineDiscount) {
        return NextResponse.json(
          forbidden("You do not have permission to apply discounts"),
          { status: 403 }
        );
      }
    }

    // --- Idempotency pre-check: replay of an already-synced sale ---
    const existing = await Sale.findOne({ clientTransactionId: data.clientTransactionId }).lean();
    if (existing) {
      return existingSaleResponse(existing);
    }

    const meta = requestMeta(req);
    const settings = await getStoreSettings(user.branchId);

    if (data.customerId) {
      const customer = await Customer.findById(data.customerId);
      if (!customer || customer.status !== "active") {
        return NextResponse.json(badRequest("Selected customer not found or inactive"), { status: 400 });
      }
    }

    if (!data.customerId && settings.requireCustomerForCredit && data.payments.some((p) => p.method === "credit")) {
      return NextResponse.json(badRequest("Credit sales require a selected customer"), { status: 400 });
    }

    if (data.discountType === "percent" && data.discount > settings.maxCashierDiscountPercent) {
      return NextResponse.json(
        badRequest(`Discount ${data.discount}% exceeds the maximum allowed (${settings.maxCashierDiscountPercent}%)`),
        { status: 400 }
      );
    }

    // Merge duplicate product lines so stock math is correct
    const merged = new Map<string, { quantity: number; unitDiscount: number }>();
    for (const item of data.items) {
      const existingItem = merged.get(item.productId);
      if (existingItem) {
        existingItem.quantity += item.quantity;
        existingItem.unitDiscount += item.unitDiscount;
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
      clientTransactionId: data.clientTransactionId,
      deviceId: data.deviceId ?? null,
    });

    await recordAuditLog({
      user,
      action: "sale.create",
      entityType: "Sale",
      entityId: result.id,
      newValue: {
        invoiceNumber: result.invoiceNumber,
        total: result.total,
        clientTransactionId: data.clientTransactionId,
        deviceId: data.deviceId ?? null,
      },
      ...meta,
    });

    return NextResponse.json(
      { success: true, data: result, message: "Sale synced" },
      { status: 201 }
    );
  } catch (error) {
    // Concurrent replay of the same clientTransactionId: the unique partial
    // index rejected the second insert — return the sale that won the race.
    if (isDuplicateKeyError(error)) {
      try {
        const body = await req.clone().json();
        const id = typeof body?.clientTransactionId === "string" ? body.clientTransactionId : "";
        if (id) {
          const existing = await Sale.findOne({ clientTransactionId: id }).lean();
          if (existing) return existingSaleResponse(existing);
        }
      } catch {
        // fall through to generic error
      }
      return NextResponse.json(
        { success: false, error: { code: "DUPLICATE_TRANSACTION", message: "Transaction already synced" } },
        { status: 409 }
      );
    }
    if (error instanceof SaleValidationError) {
      // INSUFFICIENT_STOCK is a conflict: the server's stock moved while the
      // device was offline. The client must surface it, never overwrite.
      const status = error.code === "INSUFFICIENT_STOCK" ? 409 : 400;
      return NextResponse.json(
        {
          success: false,
          error: { code: error.code, message: error.message, conflict: error.code === "INSUFFICIENT_STOCK" },
        },
        { status }
      );
    }
    // Expired/invalid session (requireAuth). Must be a 401, not a 500: the
    // sync engine distinguishes "refresh your session and retry" (401) from
    // "transient server problem" (5xx backoff).
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json(
        { success: false, error: { code: "SESSION_EXPIRED", message: "Session expired" } },
        { status: 401 }
      );
    }
    console.error("POST /api/sync/sale error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}
