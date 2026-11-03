/**
 * Attendance and salary rules — pure functions, shared by the payroll API, the
 * attendance UI and the unit tests. Nothing here touches the database.
 *
 * Explicitly defined rules:
 *  1. Every calendar day is a scheduled working day EXCEPT the configured
 *     weekly rest day (default Friday) and days explicitly marked rest/holiday.
 *  2. Employees are PRESENT by default. Only recorded exceptions count.
 *  3. Approved leave is excluded from absences and does not reduce salary.
 *  4. Each month grants ABSENCE_ALLOWANCE_DAYS (7) non-penalty absence days.
 *  5. Each absence day beyond the allowance costs exactly one day's salary,
 *     where one day's salary = monthly salary ÷ calendar days in that month.
 *  6. Payable = monthly salary − deduction (never below zero).
 */

export const ABSENCE_ALLOWANCE_DAYS = 7;
/** 0 = Sunday … 5 = Friday (default rest day) … 6 = Saturday. */
export const DEFAULT_WEEKLY_REST_DAY = 5;

export type AttendanceStatusLike = "absent" | "leave" | "rest" | "holiday";

export type MonthInfo = {
  period: string;
  year: number;
  month: number;
  daysInMonth: number;
  /** Local start-of-month (inclusive). */
  start: Date;
  /** Local start of the next month (exclusive). */
  endExclusive: Date;
};

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Parses `YYYY-MM`; returns null for malformed or out-of-range months. */
export function parsePeriod(period: string): MonthInfo | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  if (year < 2000 || year > 2100) return null;
  return {
    period,
    year,
    month,
    daysInMonth: new Date(year, month, 0).getDate(),
    start: new Date(year, month - 1, 1, 0, 0, 0, 0),
    endExclusive: new Date(year, month, 1, 0, 0, 0, 0),
  };
}

/** Calendar key in LOCAL time (attendance is a local-business-day concept). */
export function dateKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parses a `YYYY-MM-DD` key to a local midnight Date (null when invalid). */
export function parseDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function isWeeklyRestDate(date: Date, weeklyRestDay: number): boolean {
  return date.getDay() === weeklyRestDay;
}

export function countWeeklyRestDays(month: MonthInfo, weeklyRestDay: number): number {
  let count = 0;
  for (let day = 1; day <= month.daysInMonth; day += 1) {
    if (new Date(month.year, month.month - 1, day).getDay() === weeklyRestDay) count += 1;
  }
  return count;
}

export type AttendanceCounts = {
  absent: number;
  leave: number;
  rest: number;
  holiday: number;
};

export type PayrollComputationInput = {
  period: string;
  monthlySalary: number;
  weeklyRestDay?: number;
  allowanceDays?: number;
  /** Recorded exceptions only — present days have no record. */
  records: Array<{ dateKey: string; status: AttendanceStatusLike }>;
};

export type PayrollComputation = {
  period: string;
  calendarDays: number;
  scheduledDays: number;
  weeklyRestDays: number;
  restDays: number;
  leaveDays: number;
  absentDays: number;
  allowanceDays: number;
  unpaidAbsenceDays: number;
  dailyRate: number;
  deduction: number;
  monthlySalary: number;
  netPayable: number;
};

/**
 * Computes one employee's month. Records outside the period are ignored, as
 * are records on the weekly rest day (a mistake there can never create a
 * deduction). Duplicate records for one day are counted once (the last one
 * wins), matching the unique (user, day) storage rule.
 */
export function computePayroll(input: PayrollComputationInput): PayrollComputation {
  const month = parsePeriod(input.period);
  if (!month) throw new Error(`Invalid payroll period: ${input.period}`);

  const weeklyRestDay = input.weeklyRestDay ?? DEFAULT_WEEKLY_REST_DAY;
  const allowanceDays = Math.max(0, Math.floor(input.allowanceDays ?? ABSENCE_ALLOWANCE_DAYS));
  const monthlySalary = Math.max(0, Number(input.monthlySalary) || 0);

  const byDay = new Map<string, AttendanceStatusLike>();
  for (const record of input.records) {
    const date = parseDateKey(record.dateKey);
    if (!date) continue;
    if (date < month.start || date >= month.endExclusive) continue;
    if (isWeeklyRestDate(date, weeklyRestDay)) continue;
    byDay.set(record.dateKey, record.status);
  }

  const counts: AttendanceCounts = { absent: 0, leave: 0, rest: 0, holiday: 0 };
  for (const status of byDay.values()) counts[status] += 1;

  const weeklyRestDays = countWeeklyRestDays(month, weeklyRestDay);
  const restDays = counts.rest + counts.holiday;
  const scheduledDays = Math.max(0, month.daysInMonth - weeklyRestDays - restDays);
  const absentDays = counts.absent;
  const leaveDays = counts.leave;

  const unpaidAbsenceDays = Math.max(0, absentDays - allowanceDays);
  const dailyRate = roundMoney(monthlySalary / month.daysInMonth);
  const deduction = roundMoney(dailyRate * unpaidAbsenceDays);
  const netPayable = roundMoney(Math.max(0, monthlySalary - deduction));

  return {
    period: input.period,
    calendarDays: month.daysInMonth,
    scheduledDays,
    weeklyRestDays,
    restDays,
    leaveDays,
    absentDays,
    allowanceDays,
    unpaidAbsenceDays,
    dailyRate,
    deduction,
    monthlySalary: roundMoney(monthlySalary),
    netPayable,
  };
}

/** Days of a month as YYYY-MM-DD keys, for calendars. */
export function monthDateKeys(period: string): string[] {
  const month = parsePeriod(period);
  if (!month) return [];
  const keys: string[] = [];
  for (let day = 1; day <= month.daysInMonth; day += 1) {
    keys.push(dateKeyOf(new Date(month.year, month.month - 1, day)));
  }
  return keys;
}
