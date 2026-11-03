import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { Department, User } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasAnyPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { getEmployeeBenefitPolicy } from "@/lib/employee-purchase";
import { round2 } from "@/lib/commerce";

/**
 * Quick employee search for the POS "employee purchase" mode.
 * Returns the benefit the server will apply (personal → department → shop),
 * plus the balance the employee still owes, so the cashier can see it.
 */
export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (
      !(await hasAnyPermission(user, [
        PERMISSIONS.employeePurchases.process,
        PERMISSIONS.employeePurchases.view,
        PERMISSIONS.sales.create,
      ]))
    ) {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search")?.trim() ?? "";
    const limit = Math.min(20, Math.max(1, Number(searchParams.get("limit") ?? 10)));

    const query: Record<string, unknown> = { status: "active" };
    if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } },
        { phone: { $regex: escaped, $options: "i" } },
      ];
    }

    const employees = await User.find(query)
      .sort({ name: 1 })
      .limit(limit)
      .select("name email phone purchaseBenefitPercent purchaseOutstanding")
      .lean();

    const departments = await Department.find({
      employeeId: { $in: employees.map((e) => e._id) },
      status: "active",
    })
      .select("name employeeId purchaseBenefitPercent")
      .lean();
    const departmentByEmployee = new Map(departments.map((d) => [String(d.employeeId), d]));

    const policy = await getEmployeeBenefitPolicy(user.branchId);

    return NextResponse.json({
      policy: {
        enabled: policy.enabled,
        mode: policy.mode,
        defaultPercent: policy.defaultPercent,
        fixedAmount: policy.fixedAmount,
        creditAllowed: policy.creditAllowed,
        deductionMode: policy.deductionMode,
      },
      employees: employees.map((e) => {
        const department = departmentByEmployee.get(String(e._id));
        const percent =
          (e.purchaseBenefitPercent ?? 0) > 0
            ? e.purchaseBenefitPercent ?? 0
            : (department?.purchaseBenefitPercent ?? 0) > 0
              ? department?.purchaseBenefitPercent ?? 0
              : policy.defaultPercent;
        return {
          _id: String(e._id),
          name: e.name,
          email: e.email,
          departmentName: department?.name ?? "",
          benefitPercent: round2(percent),
          outstanding: round2(Math.max(0, e.purchaseOutstanding ?? 0)),
        };
      }),
    });
  } catch (error) {
    console.error("GET /api/pos/employees error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
