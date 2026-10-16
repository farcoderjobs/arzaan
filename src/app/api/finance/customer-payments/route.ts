import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Customer, CustomerTransaction } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { appendLedgerEntry } from "@/lib/customer-ledger";
import { recordCashMovement, recordPaymentDoc, escapeRegex } from "@/lib/finance-service";
import { CashRegisterError } from "@/lib/cash-register";

/**
 * Finance — Customer Payments.
 * GET  → paginated payment history (filters: customer, method, from/to, search)
 * POST → record a payment against a customer's outstanding balance.
 * Cash payments flow into the open cash register; every payment keeps method,
 * reference, user, branch and timestamp for the audit trail.
 */

const paymentMethods = ["cash", "card", "transfer", "check", "other"] as const;

const createSchema = z.object({
  customerId: z.string().min(1, "Customer is required"),
  amount: z.number().positive("Payment must be greater than zero").max(100_000_000),
  method: z.enum(paymentMethods).default("cash"),
  reference: z.string().max(200).default(""),
  note: z.string().max(500).default(""),
  allowOverpay: z.boolean().default(false),
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
    const perPage = Math.min(200, Math.max(1, Number(searchParams.get("perPage") ?? 15)));
    const method = searchParams.get("method")?.trim() ?? "";
    const customerId = searchParams.get("customerId")?.trim() ?? "";
    const search = searchParams.get("search")?.trim() ?? "";
    const from = searchParams.get("from")?.trim() ?? "";
    const to = searchParams.get("to")?.trim() ?? "";

    const query: Record<string, unknown> = { type: "PAYMENT" };
    if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);
    if (method) query.method = method;
    if (customerId) query.customerId = new mongoose.Types.ObjectId(customerId);
    if (from || to) {
      query.createdAt = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(`${to}T23:59:59.999Z`) } : {}),
      };
    }
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      query.$or = [{ description: rx }, { reference: rx }];
    }

    const [total, docs, totals] = await Promise.all([
      CustomerTransaction.countDocuments(query),
      CustomerTransaction.find(query)
        .populate<{ customerId: { _id: mongoose.Types.ObjectId; name: string } | null }>("customerId", "name")
        .populate<{ userId: { name: string } | null }>("userId", "name")
        .sort({ createdAt: -1 })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .lean(),
      CustomerTransaction.aggregate<{ total: number }>([
        { $match: query },
        { $group: { _id: null, total: { $sum: { $abs: "$amount" } } } },
      ]),
    ]);

    const rows = docs.map((d) => ({
      _id: d._id.toString(),
      customerId: d.customerId ? (d.customerId as unknown as { _id: mongoose.Types.ObjectId })._id.toString() : null,
      customerName: (d.customerId as unknown as { name: string } | null)?.name ?? "—",
      amount: Math.abs(d.amount),
      method: d.method || "—",
      reference: d.reference || "",
      description: d.description,
      balanceAfter: d.balanceAfter,
      userName: (d.userId as unknown as { name: string } | null)?.name ?? "—",
      createdAt: d.createdAt.toISOString(),
    }));

    if (searchParams.get("format") === "csv") {
      const header = "Date,Customer,Amount,Method,Reference,Recorded By,Note\n";
      const body = rows
        .map((r) =>
          [
            new Date(r.createdAt).toISOString(),
            `"${r.customerName}"`,
            r.amount.toFixed(2),
            r.method,
            `"${r.reference.replace(/"/g, '""')}"`,
            `"${r.userName}"`,
            `"${r.description.replace(/"/g, '""')}"`,
          ].join(",")
        )
        .join("\n");
      return new NextResponse(header + body, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="customer-payments-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json({
      payments: rows,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      summary: { totalAmount: round2(totals[0]?.total ?? 0) },
    });
  } catch (error) {
    console.error("GET /api/finance/customer-payments error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.customers.payment))) {
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

    const customer = await Customer.findById(data.customerId);
    if (!customer || customer.status !== "active") {
      return NextResponse.json(notFound("Customer not found or inactive"), { status: 404 });
    }

    // Outstanding balance is derived from the signed ledger — payments cannot exceed it unless explicitly allowed.
    const balanceResult = await CustomerTransaction.aggregate<{ balance: number }>([
      { $match: { customerId: new mongoose.Types.ObjectId(data.customerId) } },
      { $group: { _id: null, balance: { $sum: "$amount" } } },
    ]);
    const balance = round2(balanceResult[0]?.balance ?? 0);
    if (!data.allowOverpay && data.amount > balance + 0.001) {
      return NextResponse.json(
        badRequest(`Payment (${round2(data.amount).toFixed(2)}) exceeds the outstanding balance (${balance.toFixed(2)})`),
        { status: 400 }
      );
    }

    // Ledger entry (negative = customer owes less) with method + reference
    const entry = await appendLedgerEntry({
      customerId: data.customerId,
      branchId: customer.branchId ? customer.branchId.toString() : user.branchId,
      type: "PAYMENT",
      amount: -round2(data.amount),
      referenceType: "payment",
      referenceId: null,
      description: `Payment received (${data.method})${data.reference ? ` — ref ${data.reference}` : ""}${data.note ? ` — ${data.note}` : ""}`,
      userId: user.id,
    });

    // Stamp method/reference onto the ledger entry for the payments list
    await CustomerTransaction.updateOne({ _id: new mongoose.Types.ObjectId(entry.id) }, { method: data.method, reference: data.reference.trim() });

    // Audit payment row (amount, type, method, reference, user, branch, timestamp)
    await recordPaymentDoc({
      type: "account_receivable",
      referenceType: "customer_transaction",
      referenceId: entry.id,
      amount: data.amount,
      method: data.method,
      description: `Customer payment — ${customer.name}${data.reference ? ` (ref ${data.reference})` : ""}`,
      userId: user.id,
      branchId: customer.branchId ? customer.branchId.toString() : user.branchId,
    });

    // Cash payments go straight into the drawer
    if (data.method === "cash") {
      await recordCashMovement({
        userId: user.id,
        branchId: customer.branchId ? customer.branchId.toString() : user.branchId,
        type: "income",
        amount: data.amount,
        description: `Customer payment — ${customer.name}`,
        referenceType: "customer_payment",
        referenceId: entry.id,
      });
    }

    return NextResponse.json(success({ transactionId: entry.id, balanceAfter: entry.balanceAfter }, "Payment recorded"), { status: 201 });
  } catch (error) {
    if (error instanceof CashRegisterError) {
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message } }, { status: 400 });
    }
    console.error("POST /api/finance/customer-payments error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
