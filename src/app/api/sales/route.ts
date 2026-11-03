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
        /** Per-line price tier; omitted lines use the sale-level tier. */
        pricingMode: z.enum(["retail", "wholesale"]).optional(),
      })
    )
    .default([]),
  /** Direct items: bought in the market, sold without entering stock. */
  directItems: z
    .array(
      z.object({
        description: z.string().trim().min(1, "Description is required").max(200),
        quantity: z.number().int().min(1).max(10000),
        unitPrice: z.number().min(0.01, "Selling price must be greater than zero"),
        unitCost: z.number().min(0).default(0),
        taxRate: z.number().min(0).max(100).default(0),
      })
    )
    .max(50)
    .default([]),
  discount: z.number().min(0).default(0),
  discountType: z.enum(["amount", "percent"]).default("amount"),
  /** Explicit price tier. Authorization and eligibility are checked server-side. */
  pricingMode: z.enum(["retail", "wholesale"]).default("retail"),
  /** Whether the customer's earned reward credit is granted (once per sale). */
  grantBonus: z.boolean().default(true),
  /** Employee purchase: the staff member the sale is for (benefit is server-side). */
  employeePurchase: z
    .object({ employeeId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid employee") })
    .nullable()
    .default(null),
  payments: z
    .array(
      z.object({
        method: z.enum(["cash", "card", "transfer", "credit", "bonus"]),
        // Zero is allowed so an employee purchase can be put entirely on the
        // employee's account (settled later in Employee purchases / payroll).
        amount: z.number().min(0),
        reference: z.string().max(200).default(""),
      })
    )
    .default([]),
  note: z.string().max(500).default(""),
  status: z.enum(["completed", "held"]).default("completed"),
}).refine((data) => data.items.length + data.directItems.length > 0, {
  message: "At least one item is required",
  path: ["items"],
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
              pricingMode: existing.pricingMode ?? "retail",
              bonusEarned: existing.bonusEarned ?? 0,
              bonusRedeemed: existing.bonusRedeemed ?? 0,
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

    // Settings enforcement: cashiers cannot exceed the configured maximum percent discount.
    // Applies to the sale-level discount and to every line-level percent discount.
    if (data.discountType === "percent") {
      const maxPercent = settings.maxCashierDiscountPercent;
      if (data.discount > maxPercent) {
        return NextResponse.json(
          badRequest(`Discount ${data.discount}% exceeds the maximum allowed (${maxPercent}%)`),
          { status: 400 }
        );
      }
      const overLine = data.items.find((i) => i.unitDiscount > maxPercent);
      if (overLine) {
        return NextResponse.json(
          badRequest(`Item discount ${overLine.unitDiscount}% exceeds the maximum allowed (${maxPercent}%)`),
          { status: 400 }
        );
      }
    }

    // Wholesale pricing is a server-authorised price tier, never a client claim.
    const wholesaleAuthorized = await hasPermission(user, PERMISSIONS.sales.wholesale);
    // Any wholesale line (even inside a retail sale) needs the permission.
    const wholesaleLines = data.items.filter((i) => i.pricingMode === "wholesale").length;
    if ((data.pricingMode === "wholesale" || wholesaleLines > 0) && !wholesaleAuthorized) {
      return NextResponse.json(
        forbidden("You do not have permission to apply wholesale pricing"),
        { status: 403 }
      );
    }

    // Merge duplicate product lines so stock math is correct
    const merged = new Map<string, { quantity: number; unitDiscount: number; pricingMode?: "retail" | "wholesale" }>();
    for (const item of data.items) {
      const existing = merged.get(item.productId);
      if (existing) {
        existing.quantity += item.quantity;
        existing.unitDiscount += item.unitDiscount;
        // A line is wholesale if any of its merged rows asked for wholesale.
        if (item.pricingMode === "wholesale") existing.pricingMode = "wholesale";
      } else {
        merged.set(item.productId, {
          quantity: item.quantity,
          unitDiscount: item.unitDiscount,
          pricingMode: item.pricingMode,
        });
      }
    }

    // Expired-stock overrides are a server-side decision: the permission is
    // checked here and never trusted from the client payload.
    const allowExpired = await hasPermission(user, PERMISSIONS.sales.overrideExpired);

    // Employee purchases are processed on behalf of a staff member. The
    // benefit rate itself always comes from the server-side configuration.
    if (data.employeePurchase) {
      const mayProcess = await hasPermission(user, PERMISSIONS.employeePurchases.process);
      const mayApplyBenefit = await hasPermission(user, PERMISSIONS.employeePurchases.applyBenefit);
      if (!mayProcess || !mayApplyBenefit) {
        return NextResponse.json(forbidden("You do not have permission to process employee purchases"), {
          status: 403,
        });
      }
      if (data.customerId) {
        return NextResponse.json(badRequest("An employee purchase cannot also be billed to a customer"), {
          status: 400,
        });
      }
    }

    const result = await completeSale({
      branchId: user.branchId,
      customerId: data.customerId,
      cashierId: user.id,
      items: [...merged.entries()].map(([productId, v]) => ({ productId, ...v })),
      directItems: data.directItems,
      discount: data.discount,
      discountType: data.discountType,
      pricingMode: data.pricingMode,
      wholesaleAuthorized,
      grantBonus: data.grantBonus,
      employeePurchase: data.employeePurchase,
      employeeBenefitAuthorized: Boolean(data.employeePurchase),
      // Zero tenders are dropped here: the sale stores only money that moved.
      payments: data.payments.filter((p) => p.amount > 0),
      note: data.note,
      status: data.status,
      clientTransactionId: data.clientTransactionId ?? null,
      allowExpired,
    });

    await recordAuditLog({
      user,
      action: data.status === "held" ? "sale.hold" : "sale.create",
      entityType: "Sale",
      entityId: result.id,
      newValue: {
        invoiceNumber: result.invoiceNumber,
        total: result.total,
        paidAmount: result.paidAmount,
        creditUsed: result.creditUsed,
        pricingMode: result.pricingMode,
        wholesaleItems: result.wholesaleLines,
        bonusGranted: result.bonusGranted,
        bonusEarned: result.bonusEarned,
        bonusRedeemed: result.bonusRedeemed,
        directItems: data.directItems.length,
        expiredOverride: result.expiredOverride,
      },
      ...meta,
    });

    if (result.wholesaleLines > 0) {
      await recordAuditLog({
        user,
        action: "sale.wholesale_pricing",
        entityType: "Sale",
        entityId: result.id,
        newValue: {
          invoiceNumber: result.invoiceNumber,
          wholesaleItems: result.wholesaleLines,
          pricingMode: result.pricingMode,
        },
        note: `Wholesale price applied to ${result.wholesaleLines} item(s) on ${result.invoiceNumber}`,
        ...meta,
      });
    }

    if (result.bonusGranted && result.bonusEarned > 0) {
      await recordAuditLog({
        user,
        action: "sale.bonus_granted",
        entityType: "Sale",
        entityId: result.id,
        newValue: {
          invoiceNumber: result.invoiceNumber,
          customerId: data.customerId,
          bonusEarned: result.bonusEarned,
        },
        note: `Reward credit of ${result.bonusEarned} granted on ${result.invoiceNumber}`,
        ...meta,
      });
    }

    if (result.employeePurchase) {
      await recordAuditLog({
        user,
        action: "employee_purchase.create",
        entityType: "EmployeePurchase",
        entityId: result.id,
        newValue: {
          invoiceNumber: result.invoiceNumber,
          employeeId: result.employeePurchase.employeeId,
          benefitPercent: result.employeePurchase.benefitPercent,
          benefitAmount: result.employeePurchase.benefitAmount,
          netAmount: result.employeePurchase.netAmount,
          outstanding: result.employeePurchase.outstanding,
        },
        note: `Employee purchase for ${result.employeePurchase.employeeName} on ${result.invoiceNumber}`,
        ...meta,
      });
    }

    if (result.expiredOverride) {
      await recordAuditLog({
        user,
        action: "sale.expired_override",
        entityType: "Sale",
        entityId: result.id,
        note: `Expired stock sold on ${result.invoiceNumber} under sales.override_expired`,
        ...meta,
      });
    }

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
    // Two requests carrying the same clientTransactionId raced: the unique
    // partial index rejected the loser. The sale IS saved, so report the one
    // that won instead of failing a sale that exists.
    if (isDuplicateKeyError(error)) {
      try {
        const body = (await req.clone().json()) as { clientTransactionId?: string };
        const id = typeof body?.clientTransactionId === "string" ? body.clientTransactionId : "";
        if (id) {
          const existing = await Sale.findOne({ clientTransactionId: id }).lean();
          if (existing) {
            return NextResponse.json({
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
                pricingMode: existing.pricingMode ?? "retail",
                bonusEarned: existing.bonusEarned ?? 0,
                bonusRedeemed: existing.bonusRedeemed ?? 0,
                bonusBalance: undefined,
                expiredOverride: false,
              },
              message: "Sale already recorded",
            });
          }
        }
      } catch {
        // fall through to the generic error
      }
    }
    console.error("POST /api/sales error:", error);
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
