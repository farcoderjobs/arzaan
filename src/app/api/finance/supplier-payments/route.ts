import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Supplier, SupplierTransaction, Purchase } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { success, badRequest, forbidden, notFound } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { getSupplierBalance, recordCashMovement, recordPaymentDoc, escapeRegex } from "@/lib/finance-service";
import { CashRegisterError } from "@/lib/cash-register";

/**
 * Finance — Supplier Payments.
 * GET  → paginated payment history (filters: supplier, method, from/to)
 * POST → record a payment to a supplier (reduces the payable balance).
 * Cash payments leave the open cash register; the Payment row keeps the audit
 * fields (amount, type, method, reference, user, branch, timestamp).
 */

const paymentMethods = ["cash", "card", "transfer", "check", "other"] as const;

const createSchema = z.object({
  supplierId: z.string().min(1, "Supplier is required"),
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
    if (!(await hasPermission(user, PERMISSIONS.suppliers.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(200, Math.max(1, Number(searchParams.get("perPage") ?? 15)));
    const method = searchParams.get("method")?.trim() ?? "";
    const supplierId = searchParams.get("supplierId")?.trim() ?? "";
    const search = searchParams.get("search")?.trim() ?? "";
    const from = searchParams.get("from")?.trim() ?? "";
    const to = searchParams.get("to")?.trim() ?? "";

    const query: Record<string, unknown> = { type: "payment" };
    if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);
    if (method) query.method = method;
    if (supplierId) query.supplierId = new mongoose.Types.ObjectId(supplierId);
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
      SupplierTransaction.countDocuments(query),
      SupplierTransaction.find(query)
        .populate<{ supplierId: { _id: mongoose.Types.ObjectId; name: string } | null }>("supplierId", "name")
        .populate<{ userId: { name: string } | null }>("userId", "name")
        .sort({ createdAt: -1 })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .lean(),
      SupplierTransaction.aggregate<{ total: number }>([
        { $match: query },
        { $group: { _id: null, total: { $sum: { $abs: "$amount" } } } },
      ]),
    ]);

    const rows = docs.map((d) => ({
      _id: d._id.toString(),
      supplierId: d.supplierId ? (d.supplierId as unknown as { _id: mongoose.Types.ObjectId })._id.toString() : null,
      supplierName: (d.supplierId as unknown as { name: string } | null)?.name ?? "—",
      amount: Math.abs(d.amount),
      method: d.method || "—",
      reference: d.reference || "",
      description: d.description,
      balanceAfter: d.balanceAfter,
      userName: (d.userId as unknown as { name: string } | null)?.name ?? "—",
      createdAt: d.createdAt.toISOString(),
    }));

    if (searchParams.get("format") === "csv") {
      const header = "Date,Supplier,Amount,Method,Reference,Recorded By,Note\n";
      const body = rows
        .map((r) =>
          [
            new Date(r.createdAt).toISOString(),
            `"${r.supplierName}"`,
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
          "Content-Disposition": `attachment; filename="supplier-payments-${new Date().toISOString().slice(0, 10)}.csv"`,
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
    console.error("GET /api/finance/supplier-payments error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.suppliers.payment))) {
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

    const supplier = await Supplier.findById(data.supplierId);
    if (!supplier) {
      return NextResponse.json(notFound("Supplier not found"), { status: 404 });
    }

    const balance = await getSupplierBalance(data.supplierId);
    if (!data.allowOverpay && data.amount > balance + 0.001) {
      return NextResponse.json(
        badRequest(`Payment (${round2(data.amount).toFixed(2)}) exceeds the payable balance (${balance.toFixed(2)})`),
        { status: 400 }
      );
    }

    const balanceAfter = round2(balance - data.amount);
    const description = `Supplier payment (${data.method})${data.reference ? ` — ref ${data.reference}` : ""}${data.note ? ` — ${data.note}` : ""}`;

    const tx = await SupplierTransaction.create(
      [
        {
          supplierId: new mongoose.Types.ObjectId(data.supplierId),
          branchId: supplier.branchId ?? (user.branchId ? new mongoose.Types.ObjectId(user.branchId) : null),
          type: "payment",
          amount: -round2(data.amount),
          balanceAfter,
          method: data.method,
          reference: data.reference.trim(),
          referenceType: "payment",
          referenceId: null,
          description,
          userId: new mongoose.Types.ObjectId(user.id),
        },
      ]
    );
    const supplierTx = tx[0];

    // Allocate the payment across this supplier's open purchases (oldest
    // first) so the Purchases "Due" column — and every report that sums
    // dueAmount — reflects money paid through Finance → Supplier Payments.
    let remaining = round2(data.amount);
    const openPurchases = await Purchase.find({
      supplierId: data.supplierId,
      status: { $in: ["pending", "completed"] },
      dueAmount: { $gt: 0 },
    }).sort({ createdAt: 1 });
    for (const purchase of openPurchases) {
      if (remaining <= 0) break;
      const applied = round2(Math.min(remaining, purchase.dueAmount));
      purchase.dueAmount = round2(purchase.dueAmount - applied);
      remaining = round2(remaining - applied);
      await purchase.save();
    }

    await recordPaymentDoc({
      type: "account_payable",
      referenceType: "supplier_transaction",
      referenceId: supplierTx._id.toString(),
      amount: data.amount,
      method: data.method,
      description: `Supplier payment — ${supplier.name}${data.reference ? ` (ref ${data.reference})` : ""}`,
      userId: user.id,
      branchId: supplier.branchId ? supplier.branchId.toString() : user.branchId,
    });

    // Cash payments leave the drawer
    if (data.method === "cash") {
      await recordCashMovement({
        userId: user.id,
        branchId: supplier.branchId ? supplier.branchId.toString() : user.branchId,
        type: "expense",
        amount: -data.amount,
        description: `Supplier payment — ${supplier.name}`,
        referenceType: "supplier_payment",
        referenceId: supplierTx._id.toString(),
      });
    }

    return NextResponse.json(
      success({ transactionId: supplierTx._id.toString(), balanceAfter }, "Supplier payment recorded"),
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof CashRegisterError) {
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message } }, { status: 400 });
    }
    console.error("POST /api/finance/supplier-payments error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
