import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Customer } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasAnyPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { getCustomerBalance } from "@/lib/customer-ledger";

/** Quick customer search for the POS customer picker. */
export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (
      !(await hasAnyPermission(user, [
        PERMISSIONS.customers.view,
        PERMISSIONS.sales.create,
      ]))
    ) {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search")?.trim() ?? "";
    const limit = Math.min(20, Math.max(1, Number(searchParams.get("limit") ?? 10)));

    const query: Record<string, unknown> = { status: "active" };
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { phone: { $regex: escaped, $options: "i" } },
      ];
    }

    const customers = await Customer.find(query)
      .sort({ name: 1 })
      .limit(limit)
      .select("name phone")
      .lean();

    const results = await Promise.all(
      customers.map(async (c) => ({
        _id: c._id.toString(),
        name: c.name,
        phone: c.phone,
        balance: await getCustomerBalance(c._id.toString()),
      }))
    );

    return NextResponse.json({ customers: results });
  } catch (error) {
    console.error("GET /api/pos/customers error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
