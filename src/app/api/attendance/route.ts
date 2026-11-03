import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "@/lib/mongodb";
import { AttendanceRecord, Branch, User } from "@/models";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { badRequest, forbidden, notFound, success } from "@/lib/api";
import { assertBranchAccess, BranchAccessError } from "@/lib/branch-access";
import { recordAuditLog, requestMeta } from "@/lib/audit";
import {
  computePayroll,
  dateKeyOf,
  monthDateKeys,
  parseDateKey,
  parsePeriod,
  type AttendanceStatusLike,
} from "@/lib/payroll";
import { getPayrollPolicy, loadAttendance } from "@/lib/payroll-service";

/**
 * Attendance API.
 *
 * Attendance is exception-based: every scheduled working day is PRESENT unless
 * an absent/leave/rest/holiday record exists. Records are editable, and every
 * change is written to the audit log (who changed what, before → after).
 *
 * GET  /api/attendance?period=YYYY-MM[&branchId=&userId=]
 * POST /api/attendance  { action: "mark"|"clear", userId, date, status?, note? }
 */

const markSchema = z.object({
  action: z.literal("mark"),
  userId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid employee"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  status: z.enum(["absent", "leave", "rest", "holiday"]),
  note: z.string().max(300).optional().default(""),
});

const clearSchema = z.object({
  action: z.literal("clear"),
  userId: z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), "Invalid employee"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
});

const bodySchema = z.discriminatedUnion("action", [markSchema, clearSchema]);

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.attendance.view))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const periodParam = searchParams.get("period")?.trim() ?? "";
    const period = parsePeriod(periodParam) ? periodParam : dateKeyOf(new Date()).slice(0, 7);
    const month = parsePeriod(period)!;
    const requestedBranch = searchParams.get("branchId")?.trim() ?? "";
    const requestedUser = searchParams.get("userId")?.trim() ?? "";
    const canManage = await hasPermission(user, PERMISSIONS.attendance.manage);

    // HQ users have no branch of their own: default to the first active shop so
    // the screen always renders with a working selector.
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

    const branch = await Branch.findById(branchId).select("name type").lean();
    if (!branch) return NextResponse.json(notFound("Shop not found"), { status: 404 });

    const policy = await getPayrollPolicy(branchId);

    // Employees may see their own attendance only; managers/admins see the shop.
    const userQuery: Record<string, unknown> = {
      branchId: new mongoose.Types.ObjectId(branchId),
      status: "active",
    };
    if (!canManage) {
      userQuery._id = new mongoose.Types.ObjectId(requestedUser && requestedUser === user.id ? requestedUser : user.id);
    } else if (requestedUser) {
      userQuery._id = new mongoose.Types.ObjectId(requestedUser);
    }

    const employees = await User.find(userQuery).select("name email").sort({ name: 1 }).lean();
    const employeeIds = employees.map((e) => String(e._id));
    const attendance = await loadAttendance(period, branchId, employeeIds);

    const days = monthDateKeys(period);
    const payload = employees.map((employee) => {
      const records = attendance.get(String(employee._id)) ?? [];
      const computation = computePayroll({
        period,
        monthlySalary: 0,
        weeklyRestDay: policy.weeklyRestDay,
        allowanceDays: policy.allowanceDays,
        records,
      });
      return {
        _id: String(employee._id),
        name: employee.name,
        email: employee.email,
        records: records.sort((a, b) => a.dateKey.localeCompare(b.dateKey)),
        summary: {
          absentDays: computation.absentDays,
          leaveDays: computation.leaveDays,
          restDays: computation.restDays,
          weeklyRestDays: computation.weeklyRestDays,
          scheduledDays: computation.scheduledDays,
          unpaidAbsenceDays: computation.unpaidAbsenceDays,
        },
      };
    });

    const weeklyRestDates = days.filter((key) => {
      const date = parseDateKey(key);
      return date ? date.getDay() === policy.weeklyRestDay : false;
    });

    return NextResponse.json({
      period,
      days,
      weeklyRestDates,
      policy,
      canManage,
      branch: { _id: String(branch._id), name: branch.name },
      branches: user.branchId
        ? [{ _id: String(branch._id), name: branch.name }]
        : (await Branch.find({ status: "active", type: { $ne: "warehouse" } }).select("name").sort({ name: 1 }).lean()).map(
            (b) => ({ _id: String(b._id), name: b.name })
          ),
      employees: payload,
      monthStart: month.start,
      monthEnd: month.endExclusive,
    });
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("GET /api/attendance error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const user = await requireSessionUser();
    if (!(await hasPermission(user, PERMISSIONS.attendance.manage))) {
      return NextResponse.json(forbidden(), { status: 403 });
    }

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const path = err.path[0];
        if (typeof path === "string") fieldErrors[path] = err.message;
      });
      return NextResponse.json(badRequest("Validation failed", fieldErrors), { status: 400 });
    }
    const data = parsed.data;

    const date = parseDateKey(data.date);
    if (!date) return NextResponse.json(badRequest("Invalid date"), { status: 400 });

    const employee = await User.findById(data.userId).select("name branchId status").lean();
    if (!employee) return NextResponse.json(notFound("Employee not found"), { status: 404 });
    if (!employee.branchId) {
      return NextResponse.json(badRequest("The employee is not assigned to a shop"), { status: 400 });
    }
    assertBranchAccess(user, employee.branchId);

    const branchId = new mongoose.Types.ObjectId(String(employee.branchId));
    const meta = requestMeta(req);

    if (data.action === "mark") {
      const existing = await AttendanceRecord.findOne({ userId: data.userId, dateKey: data.date });
      const record = await AttendanceRecord.findOneAndUpdate(
        { userId: data.userId, dateKey: data.date },
        {
          $set: {
            branchId,
            date,
            status: data.status as AttendanceStatusLike,
            note: data.note ?? "",
            markedBy: new mongoose.Types.ObjectId(user.id),
            updatedBy: new mongoose.Types.ObjectId(user.id),
          },
          $setOnInsert: { userId: data.userId },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      await recordAuditLog({
        user,
        action: existing ? "attendance.update" : "attendance.mark",
        entityType: "AttendanceRecord",
        entityId: record._id.toString(),
        oldValue: existing ? { status: existing.status, note: existing.note } : undefined,
        newValue: { userId: data.userId, date: data.date, status: data.status, note: data.note ?? "" },
        note: `Attendance ${data.date} for ${employee.name}`,
        branchId: String(employee.branchId),
        ...meta,
      });

      return NextResponse.json(
        success(
          {
            record: {
              _id: record._id.toString(),
              userId: data.userId,
              dateKey: record.dateKey,
              status: record.status,
              note: record.note,
            },
          },
          existing ? "Attendance corrected" : "Attendance marked"
        )
      );
    }

    // "clear" restores the default (present).
    const existing = await AttendanceRecord.findOne({ userId: data.userId, dateKey: data.date });
    if (!existing) {
      return NextResponse.json(success({ removed: false }, "That day is already recorded as present"));
    }
    assertBranchAccess(user, existing.branchId);
    await AttendanceRecord.deleteOne({ _id: existing._id });

    await recordAuditLog({
      user,
      action: "attendance.clear",
      entityType: "AttendanceRecord",
      entityId: existing._id.toString(),
      oldValue: { status: existing.status, note: existing.note, dateKey: existing.dateKey },
      newValue: { status: "present" },
      note: `Attendance ${data.date} reset to present for ${employee.name}`,
      branchId: String(employee.branchId),
      ...meta,
    });

    return NextResponse.json(success({ removed: true }, "Attendance reset to present"));
  } catch (error) {
    if (error instanceof BranchAccessError) {
      return NextResponse.json(forbidden(error.message), { status: 403 });
    }
    console.error("POST /api/attendance error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
