import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { Customer } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, notFound, success } from "@/lib/api";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { appendBonusEntry, getCustomerBonusBalanceRaw } from "@/lib/bonus";

/**
 * POST /api/customers/[id]/bonus — manual reward-credit adjustment.
 *
 * Financial history is append-only: the adjustment becomes a new ADJUSTMENT
 * ledger row carrying the signed amount, the reason and the approving manager,
 * never an edit of what is already there. A reason is mandatory (permission
 * `bonus.adjust`), and the customer's balance can never be driven below zero.
 */

const bodySchema = z.object({
  /** Signed: positive grants credit, negative removes it. */
  amount: z.number().refine((v) => Number.isFinite(v) && v !== 0, "Amount cannot be zero"),
  reason: z.string().trim().min(3, "A reason of at least 3 characters is required").max(300),
  /** Client-supplied token so a retried request cannot apply twice. */
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.bonus.adjust))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(badRequest("Invalid customer"), { status: 400 });
    }

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(badRequest(parsed.error.errors[0]?.message ?? "Validation failed"), {
        status: 400,
      });
    }
    const { amount, reason } = parsed.data;

    const customer = await Customer.findById(id).select("name branchId bonusBalance").lean();
    if (!customer) return NextResponse.json(notFound("Customer not found"), { status: 404 });
    if (user.branchId && customer.branchId && String(customer.branchId) !== user.branchId) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const balance = await getCustomerBonusBalanceRaw(id);
    if (Math.round((balance + amount) * 100) / 100 < 0) {
      return NextResponse.json(
        badRequest(`Adjustment would take the balance below zero (current: ${balance})`),
        { status: 400 }
      );
    }

    const meta = requestMeta(req);
    const idempotencyKey =
      parsed.data.idempotencyKey ?? `manual:${id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

    const result = await appendBonusEntry({
      customerId: id,
      branchId: customer.branchId ? customer.branchId.toString() : null,
      type: "ADJUSTMENT",
      amount,
      referenceType: "adjustment",
      referenceId: null,
      description: `${amount > 0 ? "Bonus granted" : "Bonus removed"} — ${reason}`,
      approvedBy: user.id,
      reason,
      userId: user.id,
      idempotencyKey: `adjust:${id}:${idempotencyKey}`,
    });

    await recordAuditLog({
      user,
      action: "bonus.adjust",
      entityType: "Customer",
      entityId: id,
      oldValue: { bonusBalance: balance },
      newValue: { bonusBalance: result.balanceAfter, amount, reason },
      note: `Reward credit adjusted by ${amount} for ${customer.name}`,
      ...(customer.branchId ? { branchId: String(customer.branchId) } : {}),
      ...meta,
    });

    return NextResponse.json(success({ ...result, duplicate: result.duplicate }, "Reward credit adjusted"));
  } catch (error) {
    console.error("POST /api/customers/[id]/bonus error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
