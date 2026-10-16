import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Customer, Sale } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { notFound } from "@/lib/api";
import { getCustomerBalance, getCustomerLedger } from "@/lib/customer-ledger";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.customers.view))) {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    }

    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const ledgerPage = Math.max(1, Number(searchParams.get("ledgerPage") ?? 1));
    const ledgerType = searchParams.get("ledgerType") ?? "";

    const customer = await Customer.findById(id).lean();
    if (!customer) {
      return NextResponse.json(notFound("Customer not found"), { status: 404 });
    }

    const [balance, ledger, sales, salesAgg] = await Promise.all([
      getCustomerBalance(id),
      getCustomerLedger(id, { page: ledgerPage, perPage: 20, type: ledgerType || undefined }),
      Sale.find({ customerId: id, status: "completed" })
        .sort({ createdAt: -1 })
        .limit(20)
        .select("invoiceNumber createdAt total paidAmount paymentMethod status")
        .lean(),
      Sale.aggregate<{ total: number; count: number }>([
        { $match: { customerId: new (await import("mongoose")).Types.ObjectId(id), status: "completed" } },
        { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } },
      ]),
    ]);

    return NextResponse.json({
      customer,
      balance,
      ledger,
      recentSales: sales,
      lifetimeSales: {
        total: salesAgg[0]?.total ?? 0,
        count: salesAgg[0]?.count ?? 0,
      },
    });
  } catch (error) {
    console.error("GET /api/customers/[id] error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
