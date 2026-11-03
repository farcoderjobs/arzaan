import { NextRequest, NextResponse } from "next/server";
import { SaleReturn } from "@/models";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, success } from "@/lib/api";
import { getStoreSettings } from "@/lib/settings";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { createExchange } from "@/lib/exchange-service";
import { ReturnValidationError } from "@/lib/returns-service";

const returnItemSchema = z
  .object({
    lineId: z.string().min(1).optional(),
    productId: z.string().min(1).optional(),
    quantity: z.number().int().min(1).max(10000),
    restock: z.boolean().default(true),
  })
  .refine((i) => Boolean(i.lineId || i.productId), { message: "Each returned item needs a line or product" });

const replacementSchema = z
  .object({
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          quantity: z.number().int().min(1).max(10000),
          unitDiscount: z.number().min(0).default(0),
        })
      )
      .default([]),
    directItems: z
      .array(
        z.object({
          description: z.string().trim().min(1).max(200),
          quantity: z.number().int().min(1).max(10000),
          unitPrice: z.number().min(0.01),
          unitCost: z.number().min(0).default(0),
          taxRate: z.number().min(0).max(100).default(0),
        })
      )
      .default([]),
    discount: z.number().min(0).default(0),
    discountType: z.enum(["amount", "percent"]).default("amount"),
    pricingMode: z.enum(["retail", "wholesale"]).default("retail"),
  })
  .refine((r) => r.items.length + r.directItems.length > 0, { message: "Replacement cart is empty" });

const exchangeSchema = z.object({
  clientTransactionId: z.string().min(8).max(100),
  saleId: z.string().min(1),
  items: z.array(returnItemSchema).min(1, "Select at least one item to return"),
  refundMethod: z.enum(["cash", "original", "credit", "card", "transfer"]).default("cash"),
  reason: z.string().min(1, "Return reason is required").max(300),
  note: z.string().max(300).default(""),
  replacement: replacementSchema.nullable().default(null),
  payments: z
    .array(
      z.object({
        method: z.enum(["cash", "card", "transfer", "credit", "bonus"]),
        amount: z.number().positive(),
        reference: z.string().max(200).default(""),
      })
    )
    .default([]),
});

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.refund))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = exchangeSchema.safeParse(await req.json());
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const path = err.path[0];
        if (typeof path === "string") fieldErrors[path] = err.message;
      });
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }

    const data = parsed.data;
    const settings = await getStoreSettings(user.branchId);
    const wholesaleAuthorized = await hasPermission(user, PERMISSIONS.sales.wholesale);
    const allowExpired = await hasPermission(user, PERMISSIONS.sales.overrideExpired);

    if (data.replacement?.pricingMode === "wholesale" && !wholesaleAuthorized) {
      return NextResponse.json(forbidden("You do not have permission to apply wholesale pricing"), { status: 403 });
    }

    const result = await createExchange({
      saleId: data.saleId,
      userId: user.id,
      clientTransactionId: data.clientTransactionId,
      items: data.items,
      refundMethod: data.refundMethod,
      reason: data.reason,
      note: data.note,
      replacement: data.replacement,
      payments: data.payments,
      wholesaleAuthorized,
      allowExpired,
      requireApproval: settings.refundRequiresApproval,
    });

    await recordAuditLog({
      user,
      action: data.replacement ? "sale_return.exchange" : "sale_return.refund",
      entityType: "SaleReturn",
      entityId: result.id,
      newValue: {
        returnNumber: result.returnNumber,
        saleId: data.saleId,
        refundAmount: result.refundAmount,
        replacementTotal: result.replacementTotal,
        netAmount: result.netAmount,
        replacementSaleId: result.replacementSaleId,
        bonusReversed: result.bonusReversed,
        clientTransactionId: data.clientTransactionId,
      },
      note: `POS ${data.replacement ? "exchange" : "refund"}: ${data.reason}`,
      ...requestMeta(req),
    });

    return NextResponse.json(
      {
        ...success(
          result,
          result.alreadyProcessed
            ? "Refund already processed"
            : data.replacement
              ? "Exchange completed"
              : "Refund processed"
        ),
        ...(result.alreadyProcessed ? { alreadyProcessed: true } : {}),
      },
      { status: result.alreadyProcessed ? 200 : 201 }
    );
  } catch (error) {
    if (error instanceof ReturnValidationError) {
      return NextResponse.json(
        { success: false, error: { code: error.code, message: error.message } },
        { status: 400 }
      );
    }
    if (isDuplicateKeyError(error)) {
      // Concurrent replay: the first request won; return its return document.
      try {
        const body = await req.clone().json();
        const key = typeof body?.clientTransactionId === "string" ? body.clientTransactionId : "";
        if (key) {
          const existing = await SaleReturn.findOne({ clientTransactionId: key }).lean();
          if (existing) {
            return NextResponse.json(
              {
                success: true,
                alreadyProcessed: true,
                data: {
                  id: existing._id.toString(),
                  returnNumber: existing.returnNumber,
                  status: existing.status,
                  refundAmount: existing.total,
                  replacementTotal: existing.replacementTotal ?? 0,
                  netAmount: existing.netAmount ?? -existing.total,
                  refundDue: Math.max(0, -((existing.netAmount ?? -existing.total) as number)),
                  replacementSaleId: existing.exchangeSaleId?.toString() ?? null,
                  replacementInvoiceNumber: null,
                  bonusReversed: existing.bonusReversed ?? 0,
                },
                message: "Refund already processed",
              },
              { status: 200 }
            );
          }
        }
      } catch {
        // fall through
      }
      return NextResponse.json(
        { success: false, error: { code: "DUPLICATE_TRANSACTION", message: "Refund already processed" } },
        { status: 409 }
      );
    }
    console.error("POST /api/pos/exchanges error:", error);
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
