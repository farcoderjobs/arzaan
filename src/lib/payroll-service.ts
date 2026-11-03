import mongoose from "mongoose";
import { AttendanceRecord, EmployeeSalary, StoreSettings, User } from "@/models";
import {
  ABSENCE_ALLOWANCE_DAYS,
  DEFAULT_WEEKLY_REST_DAY,
  computePayroll,
  parsePeriod,
  type AttendanceStatusLike,
  type PayrollComputation,
} from "@/lib/payroll";

/**
 * Payroll orchestration: reads the attendance policy, salary configuration and
 * attendance exceptions, then applies the pure rules from `@/lib/payroll`.
 *
 * Policy defaults are explicit and documented: Friday is the weekly rest day
 * and every month grants 7 non-penalty absence days. Both can be overridden per
 * shop with the setting keys below.
 */

export const PAYROLL_SETTING_KEYS = {
  weeklyRestDay: "payroll.weekly_rest_day",
  allowanceDays: "payroll.absence_allowance_days",
};

export type PayrollPolicy = {
  weeklyRestDay: number;
  allowanceDays: number;
};

export async function getPayrollPolicy(branchId: string): Promise<PayrollPolicy> {
  const policy: PayrollPolicy = {
    weeklyRestDay: DEFAULT_WEEKLY_REST_DAY,
    allowanceDays: ABSENCE_ALLOWANCE_DAYS,
  };
  try {
    const rows = await StoreSettings.find({
      branchId: new mongoose.Types.ObjectId(branchId),
      key: { $in: Object.values(PAYROLL_SETTING_KEYS) },
    })
      .select("key value")
      .lean();
    for (const row of rows) {
      if (row.key === PAYROLL_SETTING_KEYS.weeklyRestDay) {
        const value = Number(row.value);
        if (Number.isInteger(value) && value >= 0 && value <= 6) policy.weeklyRestDay = value;
      }
      if (row.key === PAYROLL_SETTING_KEYS.allowanceDays) {
        const value = Number(row.value);
        if (Number.isInteger(value) && value >= 0 && value <= 31) policy.allowanceDays = value;
      }
    }
  } catch {
    // Missing settings / DB hiccup: documented defaults are safe.
  }
  return policy;
}

export type AttendanceRecordLite = {
  userId: string;
  dateKey: string;
  status: AttendanceStatusLike;
  note: string;
};

export async function loadAttendance(
  period: string,
  branchId: string,
  userIds?: string[]
): Promise<Map<string, AttendanceRecordLite[]>> {
  const month = parsePeriod(period);
  const map = new Map<string, AttendanceRecordLite[]>();
  if (!month) return map;

  const query: Record<string, unknown> = {
    branchId: new mongoose.Types.ObjectId(branchId),
    dateKey: { $regex: `^${period}-` },
  };
  if (userIds && userIds.length > 0) {
    query.userId = { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  const rows = await AttendanceRecord.find(query).select("userId dateKey status note").lean();
  for (const row of rows) {
    const key = String(row.userId);
    const entry: AttendanceRecordLite = {
      userId: key,
      dateKey: row.dateKey,
      status: row.status as AttendanceStatusLike,
      note: row.note ?? "",
    };
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  }
  return map;
}

export type ComputedPayrollEmployee = {
  userId: string;
  userName: string;
  monthlySalary: number;
  hasSalary: boolean;
  computation: PayrollComputation;
  records: AttendanceRecordLite[];
};

/**
 * Computes the payroll for every active employee of a shop who has a salary
 * configured. Employees without a salary are reported separately (hasSalary
 * false) instead of silently receiving a zero-pay entry.
 */
export async function computePayrollForShop(period: string, branchId: string): Promise<ComputedPayrollEmployee[]> {
  const month = parsePeriod(period);
  if (!month) throw new Error(`Invalid payroll period: ${period}`);

  const policy = await getPayrollPolicy(branchId);
  const [users, salaries] = await Promise.all([
    User.find({ branchId: new mongoose.Types.ObjectId(branchId), status: "active" })
      .select("name email")
      .sort({ name: 1 })
      .lean(),
    EmployeeSalary.find({ branchId: new mongoose.Types.ObjectId(branchId), status: "active" }).lean(),
  ]);

  const salaryMap = new Map(salaries.map((s) => [String(s.userId), s]));
  const userIds = users.map((u) => String(u._id));
  const attendance = await loadAttendance(period, branchId, userIds);

  const result: ComputedPayrollEmployee[] = [];
  for (const user of users) {
    const userId = String(user._id);
    const salary = salaryMap.get(userId);
    const records = attendance.get(userId) ?? [];
    const monthlySalary = salary?.monthlySalary ?? 0;
    result.push({
      userId,
      userName: user.name,
      monthlySalary,
      hasSalary: Boolean(salary),
      records,
      computation: computePayroll({
        period,
        monthlySalary,
        weeklyRestDay: policy.weeklyRestDay,
        allowanceDays: policy.allowanceDays,
        records,
      }),
    });
  }
  return result;
}
