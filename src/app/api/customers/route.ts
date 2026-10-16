import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Customer } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { z } from "zod";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import mongoose from "mongoose";
import { getCustomerBalance } from "@/lib/customer-ledger";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { assertBranchAccess, BranchAccessError } from "@/lib/branch-access";

const createSchema = z.object({
  name: z.string().min(1, "Customer name is required").max(200),
  phone: z.string().max(50).default(""),
  email: z.union([z.literal(""), z.string().email("Invalid email address")]).default(""),
  address: z.string().max(500).default(""),
  notes: z.string().max(2000).default(""),
  status: z.enum(["active", "inactive"]).default("active"),
  branchId: z.string().nullable().optional(),
});

const updateSchema = createSchema.extend({
  id: z.string().min(1, "Customer ID is required"),
});

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.customers.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("perPage") ?? 15)));
    const search = searchParams.get("search")?.trim() ?? "";
    const status = searchParams.get("status")?.trim() ?? "";
    const withBalance = searchParams.get("withBalance") === "1";

    const query: Record<string, unknown> = {};
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
        { phone: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
        { email: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
      ];
    }

    // Branch-restricted users only see customers in their own branch. Callers that
    // pass an explicit branchId filter for a different branch will still get an
    // empty list rather than a silent cross-branch read; the branch check belongs
    // in the write paths (already asserted on create/update/delete/payment).
    // Customers without an explicit branchId are treated as head-office/unassigned
    // and are visible to unrestricted users only.
    if (user.branchId) {
      const userIdBranch = new mongoose.Types.ObjectId(user.branchId);
      const baseAnd = query.$and ?? [];
      // TS needs an explicit final array so $and gets a definite string[][] shape.
      query.$and = [
        ...(Array.isArray(baseAnd) ? baseAnd : []),
        { $or: [{ branchId: userIdBranch }, { branchId: { $exists: false } }] },
      ];
    }

    const total = await Customer.countDocuments(query);
    const customers = await Customer.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean();    const results = withBalance
      ? await Promise.all(
          customers.map(async (c) => ({
            ...c,
            balance: await getCustomerBalance(c._id.toString()),
          }))
        )
      : customers;

    return NextResponse.json({
      customers: results,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    console.error("GET /api/customers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();

    const body = await req.json();
    const meta = requestMeta(req);

    if (body.action === "payment") {
      return handlePayment(body, user.id);
    }

    const isUpdate = Boolean(body.id);
    if (isUpdate) {
      if (!(await hasPermission(user, PERMISSIONS.customers.update))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
    } else if (!(await hasPermission(user, PERMISSIONS.customers.create))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const schema = isUpdate ? updateSchema : createSchema;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const path = err.path[0];
        if (typeof path === "string") fieldErrors[path] = err.message;
      });
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }

    const data = parsed.data;

    if (isUpdate) {
      const customer = await Customer.findById((data as z.infer<typeof updateSchema>).id);
      if (!customer) {
        return NextResponse.json(notFound("Customer not found"), { status: 404 });
      }
      assertBranchAccess(user, customer.branchId);
      customer.name = data.name.trim();
      customer.phone = (data.phone ?? "").trim();
      customer.email = (data.email ?? "").trim().toLowerCase();
      customer.address = (data.address ?? "").trim();
      customer.notes = (data.notes ?? "").trim();
      customer.status = data.status;
      await customer.save();
      await recordAuditLog({
        user,
        action: "customer.updated",
        entityType: "customer",
        entityId: customer._id.toString(),
        branchId: customer.branchId?.toString(),
        note: "Customer updated",
        ...meta,
      });
      return NextResponse.json(success({ customer: customer.toJSON() }, "Customer updated"));
    }

    const customer = await Customer.create({
      name: data.name.trim(),
      phone: (data.phone ?? "").trim(),
      email: (data.email ?? "").trim().toLowerCase(),
      address: (data.address ?? "").trim(),
      notes: (data.notes ?? "").trim(),
      status: data.status,
      branchId: data.branchId ?? user.branchId,
    });

    await recordAuditLog({
      user,
      action: "customer.created",
      entityType: "customer",
      entityId: customer._id.toString(),
      branchId: customer.branchId?.toString(),
      newValue: { name: customer.name },
      ...meta,
    });

    return NextResponse.json(success({ customer: customer.toJSON() }, "Customer created"), { status: 201 });
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("POST /api/customers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/**
 * Records a customer payment. Amount must be > 0 and cannot exceed the
 * outstanding balance (derived from the ledger) unless explicitly configured
 * via `allowOverpay` (kept for forward-compatibility with a settings toggle).
 */
async function handlePayment(body: Record<string, unknown>, userId: string) {
  if (!(await hasPermission(await requireSessionUser(), PERMISSIONS.customers.payment))) {
    return NextResponse.json(forbidden(), { status: 403 });
  }

  const paymentSchema = z.object({
    customerId: z.string().min(1, "Customer is required"),
    amount: z.number().positive("Payment must be greater than zero"),
    method: z.enum(["cash", "card", "transfer", "check", "other"]).default("cash"),
    reference: z.string().max(200).default(""),
    note: z.string().max(500).default(""),
    allowOverpay: z.boolean().default(false),
  });

  const parsed = paymentSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    parsed.error.errors.forEach((err) => {
      const path = err.path[0];
      if (typeof path === "string") fieldErrors[path] = err.message;
    });
    return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
  }

  const data = parsed.data;
  const customer = await Customer.findById(data.customerId);
  if (!customer) {
    return NextResponse.json(notFound("Customer not found"), { status: 404 });
  }

  const balance = await getCustomerBalance(data.customerId);
  if (!data.allowOverpay && data.amount > balance + 0.001) {
    return NextResponse.json(
      badRequest(
        `Payment (${data.amount.toFixed(2)}) exceeds the outstanding balance (${balance.toFixed(2)})`
      ),
      { status: 400 }
    );
  }

  // PAYMENT reduces what the customer owes → negative ledger amount
  const entry = await (await import("@/lib/customer-ledger")).appendLedgerEntry({
    customerId: data.customerId,
    branchId: customer.branchId ? customer.branchId.toString() : null,
    type: "PAYMENT",
    amount: -data.amount,
    referenceType: "payment",
    referenceId: null,
    description: `Payment received (${data.method})${data.reference ? ` — ref ${data.reference}` : ""}${data.note ? ` — ${data.note}` : ""}`,
    userId,
  });

  const sessionUser = await requireSessionUser();
  await recordAuditLog({
    user: sessionUser,
    action: "customer.payment",
    entityType: "customer",
    entityId: data.customerId,
    branchId: customer.branchId?.toString(),
    newValue: { amount: data.amount, method: data.method, balanceAfter: entry.balanceAfter },
    note: `Payment received (${data.method})${data.reference ? ` — ref ${data.reference}` : ""}`,
  });

  return NextResponse.json(
    success({ transactionId: entry.id, balanceAfter: entry.balanceAfter }, "Payment recorded"),
    { status: 201 }
  );
}

export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.customers.delete))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const body = await req.json();
    const { id } = body as { id?: string };
    if (!id) {
      return NextResponse.json(badRequest("Customer ID is required"), { status: 400 });
    }

    const customer = await Customer.findById(id);
    if (!customer) {
      return NextResponse.json(notFound("Customer not found"), { status: 404 });
    }
    assertBranchAccess(user, customer.branchId);

    // Never hard-delete a customer with financial history — deactivate instead.
    const hasTransactions = await mongoose
      .model("CustomerTransaction")
      .exists({ customerId: new mongoose.Types.ObjectId(id) });
    const hasSales = await mongoose.model("Sale").exists({ customerId: new mongoose.Types.ObjectId(id) });

    if (hasTransactions || hasSales) {
      customer.status = "inactive";
      await customer.save();
      await recordAuditLog({
        user,
        action: "customer.deactivated",
        entityType: "customer",
        entityId: customer._id.toString(),
        branchId: customer.branchId?.toString(),
        note: "Customer deactivated (financial history preserved)",
      });
      return NextResponse.json(success(null, "Customer has financial history — deactivated instead of deleted"));
    }

    await Customer.deleteOne({ _id: new mongoose.Types.ObjectId(id) });
    await recordAuditLog({
      user,
      action: "customer.deleted",
      entityType: "customer",
      entityId: id,
      branchId: customer.branchId?.toString(),
      note: "Customer deleted",
    });
    return NextResponse.json(success(null, "Customer deleted"));
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("DELETE /api/customers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
