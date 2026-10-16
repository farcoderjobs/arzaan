import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Expense, EXPENSE_CATEGORIES } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { recordCashMovement, recordPaymentDoc, escapeRegex } from "@/lib/finance-service";
import { CashRegisterError } from "@/lib/cash-register";

/**
 * Finance — Expenses.
 * GET    /api/finance/expenses  → paginated list (filters: category, status, from/to, search, format=csv)
 * POST   /api/finance/expenses  → create
 * PUT    /api/finance/expenses  → update (not allowed once canceled)
 * DELETE /api/finance/expenses  → CANCEL (void) — financial records are never physically deleted
 */

const PAYMENT_METHODS = ["cash", "card", "transfer", "check", "account", "other"] as const;

const expenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  amount: z.number().positive("Amount must be greater than zero").max(100_000_000),
  paymentMethod: z.enum(PAYMENT_METHODS),
  description: z.string().min(1, "Description is required").max(500),
  reference: z.string().max(200).default(""),
  date: z.string().optional(),
  note: z.string().max(500).default(""),
});

const updateSchema = expenseSchema.extend({ id: z.string().min(1) });

const CASH_FLOW_REFERENCE = { cash_in: "Cash in", cash_out: "Cash out" } as const;

function fieldErrors(err: z.ZodError) {
  const out: Record<string, string> = {};
  err.errors.forEach((e) => {
    const path = e.path[0];
    if (typeof path === "string") out[path] = e.message;
  });
  return out;
}

function buildQuery(searchParams: URLSearchParams, branchId: string | null) {
  const query: Record<string, unknown> = {};
  if (branchId) query.branchId = new mongoose.Types.ObjectId(branchId);
  const category = searchParams.get("category")?.trim() ?? "";
  const status = searchParams.get("status")?.trim() ?? "";
  const search = searchParams.get("search")?.trim() ?? "";
  const from = searchParams.get("from")?.trim() ?? "";
  const to = searchParams.get("to")?.trim() ?? "";
  if (category) query.category = category;
  if (status) query.status = status;
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    query.$or = [{ description: rx }, { reference: rx }, { note: rx }];
  }
  if (from || to) {
    query.date = {
      ...(from ? { $gte: new Date(from) } : {}),
      ...(to ? { $lte: new Date(`${to}T23:59:59.999Z`) } : {}),
    };
  }
  return query;
}

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.expenses.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(200, Math.max(1, Number(searchParams.get("perPage") ?? 15)));
    const query = buildQuery(searchParams, user.branchId);

    const [total, expenses, totals] = await Promise.all([
      Expense.countDocuments(query),
      Expense.find(query)
        .populate<{ userId: { name: string } | null }>("userId", "name")
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .lean(),
      Expense.aggregate<{ total: number; count: number }>([
        { $match: { ...query, status: { $ne: "canceled" } } },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
    ]);

    const rows = expenses.map((e) => ({
      _id: e._id.toString(),
      category: e.category,
      description: e.description,
      amount: e.amount,
      paymentMethod: e.paymentMethod,
      reference: e.reference ?? "",
      status: e.status,
      date: e.date ?? e.createdAt,
      userName: (e.userId as unknown as { name: string } | null)?.name ?? "—",
      note: e.note ?? "",
    }));

    if (searchParams.get("format") === "csv") {
      const header = "Date,Category,Description,Amount,Payment Method,Reference,Status,Recorded By\n";
      const body = rows
        .map((r) =>
          [
            new Date(r.date).toISOString().slice(0, 10),
            r.category,
            `"${r.description.replace(/"/g, '""')}"`,
            r.amount.toFixed(2),
            r.paymentMethod,
            `"${(r.reference ?? "").replace(/"/g, '""')}"`,
            r.status,
            `"${r.userName}"`,
          ].join(",")
        )
        .join("\n");
      return new NextResponse(header + body, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="expenses-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json({
      expenses: rows,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      summary: { totalAmount: round2(totals[0]?.total ?? 0), count: totals[0]?.count ?? 0 },
    });
  } catch (error) {
    console.error("GET /api/finance/expenses error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.expenses.create))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = expenseSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }
    const data = parsed.data;
    const amount = round2(data.amount);

    const expense = await Expense.create({
      branchId: user.branchId ? new mongoose.Types.ObjectId(user.branchId) : null,
      category: data.category,
      userId: new mongoose.Types.ObjectId(user.id),
      status: "completed",
      description: data.description.trim(),
      amount,
      tax: 0,
      total: amount,
      paidAmount: amount,
      paymentMethod: data.paymentMethod,
      reference: data.reference.trim(),
      date: data.date ? new Date(data.date) : new Date(),
      note: data.note.trim(),
    });

    // Audit + payment history
    await recordPaymentDoc({
      type: "expense",
      referenceType: "expense",
      referenceId: expense._id.toString(),
      amount,
      method: data.paymentMethod,
      description: `Expense (${data.category}) — ${data.description.trim()}`,
      userId: user.id,
      branchId: user.branchId,
    });

    // Cash expenses leave the drawer immediately
    if (data.paymentMethod === "cash") {
      await recordCashMovement({
        userId: user.id,
        branchId: user.branchId,
        type: "expense",
        amount: -amount,
        description: `Expense (${data.category}) — ${data.description.trim()}`,
        referenceType: "expense",
        referenceId: expense._id.toString(),
      });
    }

    return NextResponse.json(success({ id: expense._id.toString() }, "Expense recorded"), { status: 201 });
  } catch (error) {
    if (error instanceof CashRegisterError) {
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message } }, { status: 400 });
    }
    console.error("POST /api/finance/expenses error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.expenses.update))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = updateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }
    const data = parsed.data;

    const expense = await Expense.findById(data.id);
    if (!expense) return NextResponse.json(notFound("Expense not found"), { status: 404 });
    if (expense.status === "canceled") {
      return NextResponse.json(badRequest("Canceled expenses cannot be edited"), { status: 400 });
    }

    const previous = { amount: expense.amount, paymentMethod: expense.paymentMethod, description: expense.description, category: expense.category };

    expense.category = data.category;
    expense.description = data.description.trim();
    expense.amount = round2(data.amount);
    expense.total = round2(data.amount);
    expense.paidAmount = round2(data.amount);
    expense.paymentMethod = data.paymentMethod;
    expense.reference = data.reference.trim();
    expense.note = data.note.trim();
    if (data.date) expense.date = new Date(data.date);
    await expense.save();

    // Keep the drawer truthful when a cash expense changes
    if (previous.paymentMethod === "cash" || data.paymentMethod === "cash") {
      // Reverse the old cash effect, apply the new one
      if (previous.paymentMethod === "cash") {
        await recordCashMovement({
          userId: user.id,
          branchId: user.branchId,
          type: "adjustment",
          amount: previous.amount, // give the cash back to the drawer
          description: `Correction: ${CASH_FLOW_REFERENCE.cash_out} for edited expense`,
          referenceType: "adjustment",
          referenceId: expense._id.toString(),
        });
      }
      if (data.paymentMethod === "cash") {
        await recordCashMovement({
          userId: user.id,
          branchId: user.branchId,
          type: "expense",
          amount: -expense.amount,
          description: `Expense (${data.category}) — ${data.description.trim()}`,
          referenceType: "expense",
          referenceId: expense._id.toString(),
        });
      }
    }

    return NextResponse.json(success({ id: expense._id.toString() }, "Expense updated"));
  } catch (error) {
    if (error instanceof CashRegisterError) {
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message } }, { status: 400 });
    }
    console.error("PUT /api/finance/expenses error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.expenses.delete))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { id } = (await req.json()) as { id?: string };
    if (!id) return NextResponse.json(badRequest("Expense ID is required"), { status: 400 });

    const expense = await Expense.findById(id);
    if (!expense) return NextResponse.json(notFound("Expense not found"), { status: 404 });
    if (expense.status === "canceled") {
      return NextResponse.json(badRequest("Expense is already canceled"), { status: 400 });
    }

    expense.status = "canceled";
    await expense.save();

    // Canceled cash expenses return the money to the drawer via a signed adjustment
    if (expense.paymentMethod === "cash") {
      await recordCashMovement({
        userId: user.id,
        branchId: user.branchId,
        type: "adjustment",
        amount: expense.amount,
        description: `Reversal: canceled expense — ${expense.description.slice(0, 120)}`,
        referenceType: "adjustment",
        referenceId: expense._id.toString(),
      });
    }

    return NextResponse.json(success({ id: expense._id.toString(), status: "canceled" }, "Expense canceled (kept for audit)"));
  } catch (error) {
    if (error instanceof CashRegisterError) {
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message } }, { status: 400 });
    }
    console.error("DELETE /api/finance/expenses error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
