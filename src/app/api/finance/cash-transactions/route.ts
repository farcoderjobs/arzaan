import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { CashTransaction } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasAnyPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { forbidden } from "@/lib/api";
import { round2 } from "@/lib/commerce";
import { escapeRegex } from "@/lib/finance-service";

/**
 * Finance — Cash Transactions (read-only audit view).
 * GET /api/finance/cash-transactions → paginated drawer movements.
 * There is deliberately no POST/PUT/DELETE here: cash movements are created
 * through their business flows (sales, refunds, expenses, register actions)
 * and can never be silently deleted.
 */

const TX_TYPES = ["opening", "sale", "refund", "expense", "income", "adjustment", "closing", "purchase", "payment_in", "payment_out"];

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasAnyPermission(user, [PERMISSIONS.cashRegister.view, PERMISSIONS.reports.finance]))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(200, Math.max(1, Number(searchParams.get("perPage") ?? 20)));
    const type = searchParams.get("type")?.trim() ?? "";
    const search = searchParams.get("search")?.trim() ?? "";
    const from = searchParams.get("from")?.trim() ?? "";
    const to = searchParams.get("to")?.trim() ?? "";

    const query: Record<string, unknown> = {};
    if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);
    if (type && TX_TYPES.includes(type)) query.type = type;
    if (from || to) {
      query.createdAt = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(`${to}T23:59:59.999Z`) } : {}),
      };
    }
    if (search) {
      query.description = new RegExp(escapeRegex(search), "i");
    }

    const [total, docs, totals] = await Promise.all([
      CashTransaction.countDocuments(query),
      CashTransaction.find(query)
        .populate<{ userId: { name: string } | null }>("userId", "name")
        .populate<{ registerId: { _id: mongoose.Types.ObjectId; openedAt: Date } | null }>("registerId", "openedAt")
        .sort({ createdAt: -1 })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .lean(),
      CashTransaction.aggregate<{ inflow: number; outflow: number }>([
        { $match: { ...query, type: { $ne: "closing" } } },
        {
          $group: {
            _id: null,
            inflow: { $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] } },
            outflow: { $sum: { $cond: [{ $lt: ["$amount", 0] }, { $abs: "$amount" }, 0] } },
          },
        },
      ]),
    ]);

    const rows = docs.map((d) => ({
      _id: d._id.toString(),
      type: d.type,
      amount: d.amount,
      description: d.description,
      userName: (d.userId as unknown as { name: string } | null)?.name ?? "—",
      referenceType: d.referenceType ?? null,
      registerId: d.registerId ? (d.registerId as unknown as { _id: mongoose.Types.ObjectId })._id.toString() : null,
      createdAt: d.createdAt.toISOString(),
    }));

    if (searchParams.get("format") === "csv") {
      const header = "Date,Type,Amount,Description,Recorded By\n";
      const body = rows
        .map((r) =>
          [new Date(r.createdAt).toISOString(), r.type, r.amount.toFixed(2), `"${r.description.replace(/"/g, '""')}"`, `"${r.userName}"`].join(",")
        )
        .join("\n");
      return new NextResponse(header + body, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="cash-transactions-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json({
      transactions: rows,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      summary: {
        inflow: round2(totals[0]?.inflow ?? 0),
        outflow: round2(totals[0]?.outflow ?? 0),
        net: round2((totals[0]?.inflow ?? 0) - (totals[0]?.outflow ?? 0)),
      },
    });
  } catch (error) {
    console.error("GET /api/finance/cash-transactions error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
