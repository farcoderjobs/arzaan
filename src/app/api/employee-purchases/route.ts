import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { Department, EmployeePurchase, EmployeePurchasePayment, User } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, notFound, success } from "@/lib/api";
import { csvResponse } from "@/lib/reports";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { round2 } from "@/lib/commerce";
import { recordEmployeePurchasePayment } from "@/lib/employee-purchase";

/**
 * Employee purchases: the staff-facing mirror of customer bonus.
 *
 * GET  /api/employee-purchases         list + balances (filter by employee/status/date)
 * POST /api/employee-purchases         { action: "pay" | "exclude" | "set-rate" | "set-department-rate" }
 *
 * Outstanding balances are only moved by ledger entries; the endpoints here
 * never edit financial history in place.
 */

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pay"),
    purchaseId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid purchase"),
    amount: z.number().positive("Payment must be greater than zero"),
    method: z.enum(["cash", "card", "transfer"]).default("cash"),
    reference: z.string().max(200).optional().default(""),
    idempotencyKey: z.string().min(8).max(120).optional(),
  }),
  z.object({
    action: z.literal("exclude"),
    purchaseId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid purchase"),
    excluded: z.boolean(),
    reason: z.string().max(300).optional().default(""),
  }),
  z.object({
    action: z.literal("set-rate"),
    userId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid employee"),
    /** null clears the override so the department/shop default applies. */
    percent: z.number().min(0).max(100).nullable(),
  }),
  z.object({
    action: z.literal("set-department-rate"),
    departmentId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid department"),
    percent: z.number().min(0).max(100).nullable(),
  }),
]);

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (
      !(await hasPermission(user, PERMISSIONS.employeePurchases.view)) &&
      !(await hasPermission(user, PERMISSIONS.payroll.view))
    ) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search")?.trim() ?? "";
    const status = searchParams.get("status")?.trim() ?? "";
    const employeeId = searchParams.get("employeeId")?.trim() ?? "";
    const from = searchParams.get("from")?.trim() ?? "";
    const to = searchParams.get("to")?.trim() ?? "";
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("perPage") ?? 25)));

    const query: Record<string, unknown> = {};
    if (user.branchId) query.branchId = new mongoose.Types.ObjectId(user.branchId);
    if (status) query.status = status;
    if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) {
      query.employeeId = new mongoose.Types.ObjectId(employeeId);
    }
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { employeeName: { $regex: escaped, $options: "i" } },
        { invoiceNumber: { $regex: escaped, $options: "i" } },
        { purchaseNumber: { $regex: escaped, $options: "i" } },
      ];
    }
    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.$gte = new Date(`${from}T00:00:00.000Z`);
      if (to) range.$lte = new Date(`${to}T23:59:59.999Z`);
      query.createdAt = range;
    }

    const [total, rows, outstandingAgg, paymentsAgg, departmentAgg] = await Promise.all([
      EmployeePurchase.countDocuments(query),
      EmployeePurchase.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .lean(),
      EmployeePurchase.aggregate<{ _id: mongoose.Types.ObjectId; total: number; benefit: number; net: number }>([
        { $match: { ...query, status: { $in: ["open", "settled", "deducted"] } } },
        {
          $group: {
            _id: "$employeeId",
            total: { $sum: "$outstandingAmount" },
            benefit: { $sum: "$benefitAmount" },
            net: { $sum: "$netAmount" },
          },
        },
      ]),
      EmployeePurchasePayment.aggregate<{ _id: mongoose.Types.ObjectId; paid: number }>([
        ...(user.branchId ? [{ $match: { branchId: new mongoose.Types.ObjectId(user.branchId) } }] : []),
        { $group: { _id: "$employeeId", paid: { $sum: "$amount" } } },
      ]),
      EmployeePurchase.aggregate<{ _id: string; net: number; benefit: number }>([
        { $match: { ...query, status: { $ne: "canceled" } } },
        { $group: { _id: "$departmentName", net: { $sum: "$netAmount" }, benefit: { $sum: "$benefitAmount" } } },
        { $sort: { net: -1 } },
      ]),
    ]);

    const employeeIds = [...new Set([...outstandingAgg.map((r) => String(r._id)), ...rows.map((r) => String(r.employeeId))])];
    const employees = await User.find({ _id: { $in: employeeIds.map((id) => new mongoose.Types.ObjectId(id)) } })
      .select("name email purchaseBenefitPercent purchaseOutstanding")
      .lean();
    const employeeMap = new Map(employees.map((e) => [String(e._id), e]));
    const paidMap = new Map(paymentsAgg.map((r) => [String(r._id), r.paid]));

    const summary = {
      outstanding: round2(outstandingAgg.reduce((s, r) => s + r.total, 0)),
      net: round2(outstandingAgg.reduce((s, r) => s + r.net, 0)),
      benefit: round2(outstandingAgg.reduce((s, r) => s + r.benefit, 0)),
      paid: round2(paymentsAgg.reduce((s, r) => s + r.paid, 0)),
      count: total,
    };

    if (searchParams.get("format") === "csv") {
      const csvRows: Array<Array<string | number>> = [
        ["Purchase #", "Invoice", "Employee", "Department", "Gross", "Benefit", "Net", "Paid", "Outstanding", "Status", "Payroll period", "Excluded", "Date"],
      ];
      for (const r of rows) {
        csvRows.push([
          r.purchaseNumber,
          r.invoiceNumber,
          r.employeeName || employeeMap.get(String(r.employeeId))?.name || "",
          r.departmentName || "",
          r.grossAmount,
          r.benefitAmount,
          r.netAmount,
          r.paidAmount,
          r.outstandingAmount,
          r.status,
          r.payrollPeriod || "",
          r.payrollExcluded ? "yes" : "no",
          r.createdAt.toISOString(),
        ]);
      }
      csvRows.push([]);
      csvRows.push(["TOTAL OUTSTANDING", "", "", "", "", "", "", "", summary.outstanding]);
      csvRows.push(["TOTAL BENEFIT", "", "", "", "", summary.benefit, "", "", ""]);
      csvRows.push(["TOTAL PAID", "", "", "", "", "", "", summary.paid, ""]);
      for (const d of departmentAgg) {
        csvRows.push(["DEPARTMENT", "", d._id || "Unassigned", "", round2(d.net), round2(d.benefit), "", "", ""]);
      }
      return csvResponse(`employee-purchases-${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
    }

    return NextResponse.json({
      purchases: rows.map((r) => ({
        _id: r._id.toString(),
        purchaseNumber: r.purchaseNumber,
        invoiceNumber: r.invoiceNumber,
        employeeId: String(r.employeeId),
        employeeName: r.employeeName || employeeMap.get(String(r.employeeId))?.name || "",
        departmentName: r.departmentName,
        benefitMode: r.benefitMode,
        benefitPercent: r.benefitPercent,
        grossAmount: r.grossAmount,
        benefitAmount: r.benefitAmount,
        netAmount: r.netAmount,
        paidAmount: r.paidAmount,
        outstandingAmount: r.outstandingAmount,
        status: r.status,
        payrollPeriod: r.payrollPeriod,
        payrollExcluded: r.payrollExcluded,
        createdAt: r.createdAt.toISOString(),
      })),
      summary,
      byEmployee: outstandingAgg
        .map((r) => {
          const employee = employeeMap.get(String(r._id));
          return {
            employeeId: String(r._id),
            name: employee?.name ?? "",
            email: employee?.email ?? "",
            bonusPercent: employee?.purchaseBenefitPercent ?? null,
            outstanding: round2(r.total),
            net: round2(r.net),
            benefit: round2(r.benefit),
            paid: round2(paidMap.get(String(r._id)) ?? 0),
          };
        })
        .sort((a, b) => b.outstanding - a.outstanding),
      byDepartment: departmentAgg.map((r) => ({
        department: r._id || "Unassigned",
        net: round2(r.net),
        benefit: round2(r.benefit),
      })),
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
      canPay: await hasPermission(user, PERMISSIONS.employeePurchases.pay),
      canExclude: await hasPermission(user, PERMISSIONS.employeePurchases.approveDeduction),
      canConfigure: await hasPermission(user, PERMISSIONS.employeePurchases.configure),
    });
  } catch (error) {
    console.error("GET /api/employee-purchases error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    const meta = requestMeta(req);

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(badRequest(parsed.error.errors[0]?.message ?? "Validation failed"), {
        status: 400,
      });
    }
    const data = parsed.data;

    if (data.action === "pay") {
      if (!(await hasPermission(user, PERMISSIONS.employeePurchases.pay))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      const purchase = await EmployeePurchase.findById(data.purchaseId).lean();
      if (!purchase) return NextResponse.json(notFound("Employee purchase not found"), { status: 404 });
      if (user.branchId && String(purchase.branchId) !== user.branchId) {
        return NextResponse.json(forbidden(), { status: 403 });
      }

      const result = await recordEmployeePurchasePayment({
        purchaseId: data.purchaseId,
        amount: data.amount,
        method: data.method,
        reference: data.reference,
        userId: user.id,
        idempotencyKey: data.idempotencyKey,
      });

      await recordAuditLog({
        user,
        action: "employee_purchase.payment",
        entityType: "EmployeePurchase",
        entityId: data.purchaseId,
        newValue: { amount: data.amount, method: data.method, ...result },
        note: `Employee purchase payment — ${purchase.employeeName}`,
        branchId: String(purchase.branchId),
        ...meta,
      });

      return NextResponse.json(success(result, "Payment recorded"));
    }

    if (data.action === "exclude") {
      if (!(await hasPermission(user, PERMISSIONS.employeePurchases.approveDeduction))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      const purchase = await EmployeePurchase.findById(data.purchaseId);
      if (!purchase) return NextResponse.json(notFound("Employee purchase not found"), { status: 404 });
      if (purchase.status === "deducted") {
        return NextResponse.json(badRequest("This purchase was already recovered by payroll"), { status: 400 });
      }
      const before = purchase.payrollExcluded;
      purchase.payrollExcluded = data.excluded;
      if (data.reason) purchase.note = data.reason.slice(0, 300);
      await purchase.save();

      await recordAuditLog({
        user,
        action: data.excluded ? "employee_purchase.payroll_exclude" : "employee_purchase.payroll_include",
        entityType: "EmployeePurchase",
        entityId: purchase._id.toString(),
        oldValue: { payrollExcluded: before },
        newValue: { payrollExcluded: purchase.payrollExcluded, reason: data.reason },
        note: `Payroll ${data.excluded ? "excluded" : "included"} for ${purchase.purchaseNumber}`,
        branchId: String(purchase.branchId),
        ...meta,
      });
      return NextResponse.json(success({ payrollExcluded: purchase.payrollExcluded }, "Updated"));
    }

    if (data.action === "set-rate") {
      if (!(await hasPermission(user, PERMISSIONS.employeePurchases.configure))) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      const employee = await User.findById(data.userId).select("name branchId purchaseBenefitPercent").lean();
      if (!employee) return NextResponse.json(notFound("Employee not found"), { status: 404 });
      if (user.branchId && employee.branchId && String(employee.branchId) !== user.branchId) {
        return NextResponse.json(forbidden(), { status: 403 });
      }
      await User.updateOne({ _id: data.userId }, { $set: { purchaseBenefitPercent: data.percent } });

      await recordAuditLog({
        user,
        action: "employee_purchase.rate",
        entityType: "User",
        entityId: data.userId,
        oldValue: { percent: employee.purchaseBenefitPercent ?? null },
        newValue: { percent: data.percent },
        note: `Employee purchase rate for ${employee.name}`,
        ...meta,
      });
      return NextResponse.json(success({ percent: data.percent }, "Rate saved"));
    }

    // set-department-rate
    if (!(await hasPermission(user, PERMISSIONS.employeePurchases.configure))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }
    const department = await Department.findById(data.departmentId).select("name branchId purchaseBenefitPercent").lean();
    if (!department) return NextResponse.json(notFound("Department not found"), { status: 404 });
    if (user.branchId && String(department.branchId) !== user.branchId) {
      return NextResponse.json(forbidden(), { status: 403 });
    }
    await Department.updateOne({ _id: data.departmentId }, { $set: { purchaseBenefitPercent: data.percent } });

    await recordAuditLog({
      user,
      action: "employee_purchase.department_rate",
      entityType: "Department",
      entityId: data.departmentId,
      oldValue: { percent: department.purchaseBenefitPercent ?? null },
      newValue: { percent: data.percent },
      note: `Department purchase rate for ${department.name}`,
      branchId: String(department.branchId),
      ...meta,
    });
    return NextResponse.json(success({ percent: data.percent }, "Rate saved"));
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      return NextResponse.json(badRequest("This action was already recorded (duplicate prevented)"), {
        status: 400,
      });
    }
    console.error("POST /api/employee-purchases error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
