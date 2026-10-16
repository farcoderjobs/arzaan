import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Sale, User } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";

/** Distinct cashiers and customers present in sales, for filter dropdowns. */
export async function GET(_req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.sales.view))) {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    }

    const cashierIds = await Sale.distinct("cashierId");
    const cashiers = await User.find({ _id: { $in: cashierIds } })
      .select("name")
      .sort({ name: 1 })
      .lean();

    return NextResponse.json({
      cashiers: cashiers.map((c) => ({ _id: c._id.toString(), name: c.name })),
    });
  } catch (error) {
    console.error("GET /api/sales/filters error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
