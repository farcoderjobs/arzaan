import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { Branch, EmployeeSalary, PayrollEntry, PayrollPeriod, User } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, notFound, success } from "@/lib/api";
import { assertBranchAccess, BranchAccessError } from "@/lib/branch-access";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import { roundMoney, parsePeriod, dateKeyOf } from "@/lib/payroll";
import { computePayrollForShop, getPayrollPolicy } from "@/lib/payroll-service";
import {
  applyPayrollPurchaseDeductions,
  planPayrollPurchaseDeductions,
  stagePayrollPurchaseDeductions,
} from "@/lib/employee-purchase";
import { EmployeePurchaseDeduction } from "@/models";

/**
 * Payroll API.
 *
 * GET  /api/payroll?period=YYYY-MM[&branchId=]
 * POST /api/payroll { action: "set-salary" | "generate" | "finalize" | "pay" }
 *
 * A payroll month is generated once and finalized once. Finalized months are
 * immutable (regeneration is refused); recording a payment is the only mutation
 * after finalization, and every change is audited. Unique indexes on
 * (user, period, branch) and (payroll, user) make a duplicate salary row or a
 * duplicate payment for one period impossible, even under concurrent requests.
 */

const periodField = z.string().regex(/^\d{4}-\d{2}$/, "Period must be YYYY-MM");

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set-salary"),
    userId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid employee"),
    monthlySalary: z.number().min(0, "Salary cannot be negative").max(1_000_000_000),
    note: z.string().max(300).optional().default(""),
  }),
  z.object({ action: z.literal("generate"), period: periodField, branchId: z.string().optional() }),
  z.object({ action: z.literal("finalize"), period: periodField, branchId: z.string().optional() }),
  z.object({
    action: z.literal("pay"),
    period: periodField,
    branchId: z.string().optional(),
    userId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid employee"),
    amount: z.number().positive("Payment must be greater than zero"),
    note: z.string().max(300).optional().default(""),
  }),
]);

function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  err.errors.forEach((e) => {
    const path = e.path[0];
    if (typeof path === "string") out[path] = e.message;
  });
  return out;
}

type PayrollTotals = {
  employees: number;
  grossSalary: number;
  deductions: number;
  netPayable: number;
  paidAmount: number;
  outstanding: number;
  absentDays: number;
};

function totalsFromEntries(
  entries: Array<{
    monthlySalary: number;
    deduction: number;
    purchaseDeduction?: number;
    netPayable: number;
    paidAmount?: number;
    absentDays: number;
  }>,
  employeeCount = entries.length
): PayrollTotals {
  const grossSalary = roundMoney(entries.reduce((s, e) => s + (e.monthlySalary ?? 0), 0));
  const deductions = roundMoney(
    entries.reduce((s, e) => s + (e.deduction ?? 0) + (e.purchaseDeduction ?? 0), 0)
  );
  const netPayable = roundMoney(entries.reduce((s, e) => s + (e.netPayable ?? 0), 0));
  const paidAmount = roundMoney(entries.reduce((s, e) => s + (e.paidAmount ?? 0), 0));
  return {
    employees: employeeCount,
    grossSalary,
    deductions,
    netPayable,
    paidAmount,
    outstanding: roundMoney(Math.max(0, netPayable - paidAmount)),
    absentDays: entries.reduce((s, e) => s + (e.absentDays ?? 0), 0),
  };
}

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.payroll.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const periodParam = searchParams.get("period")?.trim() ?? "";
    const period = parsePeriod(periodParam) ? periodParam : dateKeyOf(new Date()).slice(0, 7);
    const requestedBranch = searchParams.get("branchId")?.trim() ?? "";

    // HQ users have no branch of their own: default to the first active shop.
    let branchId = user.branchId ?? (requestedBranch || null);
    if (!branchId) {
      const first = await Branch.findOne({ status: "active", type: { $ne: "warehouse" } })
        .sort({ name: 1 })
        .select("_id")
        .lean();
      branchId = first ? String(first._id) : null;
    }
    if (!branchId) {
      return NextResponse.json({ error: "No active shop exists yet" }, { status: 400 });
    }
    assertBranchAccess(user, branchId);

    const branch = await Branch.findById(branchId).select("name").lean();
    if (!branch) return NextResponse.json(notFound("Shop not found"), { status: 404 });

    const [policy, computed, salaries, payroll, branches] = await Promise.all([
      getPayrollPolicy(branchId),
      computePayrollForShop(period, branchId),
      EmployeeSalary.find({ branchId: new mongoose.Types.ObjectId(branchId), status: "active" }).lean(),
      PayrollPeriod.findOne({ branchId: new mongoose.Types.ObjectId(branchId), period }).lean(),
      user.branchId
        ? Promise.resolve([{ _id: branchId, name: branch.name }])
        : Branch.find({ status: "active", type: { $ne: "warehouse" } }).select("name").sort({ name: 1 }).lean(),
    ]);

    const entries = payroll
      ? await PayrollEntry.find({ payrollId: payroll._id }).sort({ userName: 1 }).lean()
      : [];

    const salaryMap = new Map(salaries.map((s) => [String(s.userId), s]));

    // Employee-purchase recovery: what the draft would deduct and what is
    // already staged/applied for this run.
    const purchasePlan = payroll
      ? new Map<string, { amount: number; purchases: Array<{ id: string; purchaseNumber: string; amount: number }> }>()
      : await planPayrollPurchaseDeductions({
          branchId,
          period,
          employees: computed
            .filter((row) => row.hasSalary)
            .map((row) => ({ userId: row.userId, netSalary: row.computation.netPayable })),
        });
    const stagedDeductions = payroll
      ? await EmployeePurchaseDeduction.find({ payrollId: payroll._id }).lean()
      : [];
    const stagedByUser = new Map<string, typeof stagedDeductions>();
    for (const row of stagedDeductions) {
      const key = String(row.employeeId);
      const list = stagedByUser.get(key);
      if (list) list.push(row);
      else stagedByUser.set(key, [row]);
    }

    return NextResponse.json({
      period,
      policy,
      branch: { _id: String(branch._id), name: branch.name },
      branches: branches.map((b) => ({ _id: String(b._id), name: b.name })),
      canManage: await hasPermission(user, PERMISSIONS.payroll.manage),
      payroll: payroll
        ? {
            _id: String(payroll._id),
            status: payroll.status,
            totals: payroll.totals,
            generatedAt: payroll.generatedAt,
            finalizedAt: payroll.finalizedAt,
          }
        : null,
      entries: entries.map((e) => ({
        _id: String(e._id),
        userId: String(e.userId),
        userName: e.userName,
        monthlySalary: e.monthlySalary,
        calendarDays: e.calendarDays,
        scheduledDays: e.scheduledDays,
        restDays: e.restDays,
        leaveDays: e.leaveDays,
        absentDays: e.absentDays,
        allowanceDays: e.allowanceDays,
        unpaidAbsenceDays: e.unpaidAbsenceDays,
        dailyRate: e.dailyRate,
        deduction: e.deduction,
        purchaseDeduction: e.purchaseDeduction ?? 0,
        purchaseDeductions: (stagedByUser.get(String(e.userId)) ?? []).map((row) => ({
          _id: row._id.toString(),
          employeePurchaseId: row.employeePurchaseId.toString(),
          amount: row.amount,
          status: row.status,
        })),
        netPayable: e.netPayable,
        paidAmount: e.paidAmount,
        status: e.status,
      })),
      preview: computed.map((row) => ({
        userId: row.userId,
        userName: row.userName,
        hasSalary: row.hasSalary,
        salaryNote: salaryMap.get(row.userId)?.note ?? "",
        ...row.computation,
        purchaseDeduction: roundMoney(purchasePlan.get(row.userId)?.amount ?? 0),
        purchaseDeductionItems: purchasePlan.get(row.userId)?.purchases ?? [],
        netAfterPurchases: roundMoney(
          Math.max(0, row.computation.netPayable - (purchasePlan.get(row.userId)?.amount ?? 0))
        ),
      })),
      previewSummary: totalsFromEntries(
        computed.map((row) => ({
          ...row.computation,
          purchaseDeduction: roundMoney(purchasePlan.get(row.userId)?.amount ?? 0),
          netPayable: roundMoney(
            Math.max(0, row.computation.netPayable - (purchasePlan.get(row.userId)?.amount ?? 0))
          ),
        }))
      ),
    });
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("GET /api/payroll error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.payroll.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(badRequest("Validation failed", fieldErrors(parsed.error)), { status: 400 });
    }
    const data = parsed.data;
    const meta = requestMeta(req);

    // ---------------- Salary configuration ----------------
    if (data.action === "set-salary") {
      const employee = await User.findById(data.userId).select("name branchId status").lean();
      if (!employee) return NextResponse.json(notFound("Employee not found"), { status: 404 });
      if (!employee.branchId) {
        return NextResponse.json(badRequest("The employee is not assigned to a shop"), { status: 400 });
      }
      assertBranchAccess(user, employee.branchId);

      const previous = await EmployeeSalary.findOne({ userId: data.userId }).lean();
      const salary = await EmployeeSalary.findOneAndUpdate(
        { userId: data.userId },
        {
          $set: {
            branchId: employee.branchId,
            monthlySalary: roundMoney(data.monthlySalary),
            note: data.note ?? "",
            status: "active",
            updatedBy: new mongoose.Types.ObjectId(user.id),
          },
          $setOnInsert: {
            userId: data.userId,
            currency: "AFN",
            effectiveFrom: new Date(),
            createdBy: new mongoose.Types.ObjectId(user.id),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      await recordAuditLog({
        user,
        action: "payroll.salary.set",
        entityType: "EmployeeSalary",
        entityId: salary._id.toString(),
        oldValue: previous ? { monthlySalary: previous.monthlySalary } : undefined,
        newValue: { userId: data.userId, monthlySalary: salary.monthlySalary, note: salary.note },
        note: `Salary configured for ${employee.name}`,
        branchId: String(employee.branchId),
        ...meta,
      });

      return NextResponse.json(
        success({ salary: { userId: data.userId, monthlySalary: salary.monthlySalary } }, "Salary saved")
      );
    }

    const period = data.period;
    const month = parsePeriod(period);
    if (!month) return NextResponse.json(badRequest("Invalid payroll period"), { status: 400 });

    // Every remaining action is performed for one shop.
    const effectiveBranchId = user.branchId ?? data.branchId ?? null;
    if (!effectiveBranchId) {
      return NextResponse.json(badRequest("Select a shop (branchId) before changing payroll"), { status: 400 });
    }
    assertBranchAccess(user, effectiveBranchId);

    const existing = await PayrollPeriod.findOne({
      branchId: new mongoose.Types.ObjectId(effectiveBranchId),
      period,
    });

    // ---------------- Generate ----------------
    if (data.action === "generate") {
      if (existing?.status === "finalized") {
        return NextResponse.json(
          badRequest("This payroll month is finalized. Corrections must be audited, not regenerated."),
          { status: 400 }
        );
      }

      const computed = await computePayrollForShop(period, effectiveBranchId);
      const payable = computed.filter((row) => row.hasSalary);
      if (payable.length === 0) {
        return NextResponse.json(badRequest("No employee has a salary configured for this shop"), { status: 400 });
      }

      const payrollId = existing?._id ?? new mongoose.Types.ObjectId();

      // Employee purchases on credit are recovered from this salary. The plan
      // is computed before the entries exist, then staged as pending deduction
      // rows; the employee balance only moves when payroll is finalized.
      const purchasePlan = await planPayrollPurchaseDeductions({
        branchId: effectiveBranchId,
        period,
        employees: payable.map((row) => ({ userId: row.userId, netSalary: row.computation.netPayable })),
      });

      const entryRows = payable.map((row) => {
        const purchaseDeduction = roundMoney(purchasePlan.get(row.userId)?.amount ?? 0);
        return {
          payrollId,
          branchId: new mongoose.Types.ObjectId(effectiveBranchId),
          userId: new mongoose.Types.ObjectId(row.userId),
          userName: row.userName,
          period,
          monthlySalary: row.computation.monthlySalary,
          calendarDays: row.computation.calendarDays,
          scheduledDays: row.computation.scheduledDays,
          restDays: row.computation.weeklyRestDays + row.computation.restDays,
          leaveDays: row.computation.leaveDays,
          absentDays: row.computation.absentDays,
          allowanceDays: row.computation.allowanceDays,
          unpaidAbsenceDays: row.computation.unpaidAbsenceDays,
          dailyRate: row.computation.dailyRate,
          deduction: row.computation.deduction,
          purchaseDeduction,
          netPayable: roundMoney(Math.max(0, row.computation.netPayable - purchaseDeduction)),
          paidAmount: 0,
          status: "unpaid" as const,
        };
      });
      const totals = totalsFromEntries(entryRows, computed.length);

      if (existing) {
        await PayrollEntry.deleteMany({ payrollId: existing._id });
        existing.status = "draft";
        existing.totals = totals;
        existing.generatedBy = new mongoose.Types.ObjectId(user.id);
        existing.generatedAt = new Date();
        await existing.save();
      } else {
        await PayrollPeriod.create({
          _id: payrollId,
          branchId: new mongoose.Types.ObjectId(effectiveBranchId),
          period,
          status: "draft",
          totals,
          generatedBy: new mongoose.Types.ObjectId(user.id),
          generatedAt: new Date(),
        });
      }

      const entries = await PayrollEntry.insertMany(entryRows);
      await stagePayrollPurchaseDeductions({
        branchId: effectiveBranchId,
        period,
        payrollId: payrollId.toString(),
        entries: entries.map((e) => ({ userId: e.userId.toString(), entryId: e._id.toString() })),
        plan: purchasePlan,
        userId: user.id,
      });

      await recordAuditLog({
        user,
        action: "payroll.generate",
        entityType: "PayrollPeriod",
        entityId: String(payrollId),
        newValue: {
          period,
          totals,
          purchaseDeductions: [...purchasePlan.values()].reduce((s, row) => s + row.amount, 0),
        },
        note: `Payroll ${period} generated`,
        branchId: effectiveBranchId,
        ...meta,
      });

      return NextResponse.json(
        success({ payrollId: String(payrollId), totals }, "Payroll generated"),
        { status: 201 }
      );
    }

    if (!existing) {
      return NextResponse.json(notFound("Generate this payroll month first"), { status: 404 });
    }

    // ---------------- Finalize ----------------
    if (data.action === "finalize") {
      if (existing.status === "finalized") {
        return NextResponse.json(badRequest("Payroll is already finalized"), { status: 400 });
      }
      const entries = await PayrollEntry.find({ payrollId: existing._id }).lean();
      if (entries.length === 0) {
        return NextResponse.json(badRequest("There are no payroll entries to finalize"), { status: 400 });
      }
      existing.status = "finalized";
      existing.finalizedBy = new mongoose.Types.ObjectId(user.id);
      existing.finalizedAt = new Date();
      await existing.save();

      // Apply the staged employee-purchase deductions: idempotent, and each
      // purchase can only ever be deducted once (unique index).
      const applied = await applyPayrollPurchaseDeductions({
        payrollId: existing._id.toString(),
        period,
        branchId: effectiveBranchId,
        userId: user.id,
      });

      await recordAuditLog({
        user,
        action: "payroll.finalize",
        entityType: "PayrollPeriod",
        entityId: existing._id.toString(),
        oldValue: { status: "draft" },
        newValue: {
          status: "finalized",
          totals: existing.totals,
          employeePurchaseDeductions: applied,
        },
        note: `Payroll ${period} finalized${applied.applied > 0 ? ` — ${applied.total} recovered from employee purchases` : ""}`,
        branchId: effectiveBranchId,
        ...meta,
      });
      return NextResponse.json(success({ status: existing.status }, "Payroll finalized"));
    }

    // ---------------- Record payment ----------------
    if (existing.status !== "finalized") {
      return NextResponse.json(badRequest("Finalize the payroll before recording payments"), { status: 400 });
    }
    const entry = await PayrollEntry.findOne({
      payrollId: existing._id,
      userId: new mongoose.Types.ObjectId(data.userId),
    });
    if (!entry) return NextResponse.json(notFound("Payroll entry not found"), { status: 404 });

    const outstanding = roundMoney(entry.netPayable - entry.paidAmount);
    if (outstanding <= 0) {
      return NextResponse.json(badRequest("This salary is already fully paid"), { status: 400 });
    }
    if (data.amount > outstanding + 0.001) {
      return NextResponse.json(
        badRequest(`Payment exceeds the outstanding salary (${outstanding.toFixed(2)})`),
        { status: 400 }
      );
    }

    const before = entry.paidAmount;
    entry.paidAmount = roundMoney(entry.paidAmount + data.amount);
    entry.status = entry.paidAmount >= entry.netPayable - 0.001 ? "paid" : "partial";
    entry.lastPaidAt = new Date();
    if (data.note) entry.note = data.note;
    await entry.save();

    const allEntries = await PayrollEntry.find({ payrollId: existing._id }).lean();
    existing.totals = totalsFromEntries(allEntries);
    await existing.save();

    await recordAuditLog({
      user,
      action: "payroll.pay",
      entityType: "PayrollEntry",
      entityId: entry._id.toString(),
      oldValue: { paidAmount: before },
      newValue: { paidAmount: entry.paidAmount, status: entry.status },
      note: `Salary payment ${period} for ${entry.userName}`,
      branchId: effectiveBranchId,
      ...meta,
    });

    return NextResponse.json(
      success(
        { paidAmount: entry.paidAmount, status: entry.status, outstanding: roundMoney(entry.netPayable - entry.paidAmount) },
        "Payment recorded"
      )
    );
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      return NextResponse.json(badRequest("This payroll month already exists (duplicate prevented)"), { status: 400 });
    }
    console.error("POST /api/payroll error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
