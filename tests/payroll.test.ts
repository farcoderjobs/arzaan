import { describe, expect, it } from "vitest";
import {
  ABSENCE_ALLOWANCE_DAYS,
  computePayroll,
  countWeeklyRestDays,
  dateKeyOf,
  monthDateKeys,
  parseDateKey,
  parsePeriod,
} from "../src/lib/payroll";

/** `count` absence records on working days (the weekly rest day is skipped). */
const absences = (count: number, period = "2026-01", weeklyRestDay = 5) => {
  const month = parsePeriod(period)!;
  const records: Array<{ dateKey: string; status: "absent" }> = [];
  for (let day = 1; day <= month.daysInMonth && records.length < count; day += 1) {
    const date = new Date(month.year, month.month - 1, day);
    if (date.getDay() === weeklyRestDay) continue;
    records.push({ dateKey: `${period}-${String(day).padStart(2, "0")}`, status: "absent" });
  }
  return records;
};

describe("payroll month rules", () => {
  it("defines the seven-day non-penalty allowance by default", () => {
    expect(ABSENCE_ALLOWANCE_DAYS).toBe(7);
  });

  it("parses periods and counts calendar days by month length", () => {
    expect(parsePeriod("2026-02")?.daysInMonth).toBe(28);
    expect(parsePeriod("2026-04")?.daysInMonth).toBe(30);
    expect(parsePeriod("2026-12")?.daysInMonth).toBe(31);
    expect(parsePeriod("2026-13")).toBeNull();
    expect(parsePeriod("not-a-month")).toBeNull();
  });

  it("pays the full salary for the first seven absence days", () => {
    // January 2026 has 31 days; weekly rest days are excluded from scheduling
    // but the salary base is monthly / calendar days.
    const result = computePayroll({
      period: "2026-01",
      monthlySalary: 3100,
      weeklyRestDay: 5,
      records: absences(7),
    });
    expect(result.absentDays).toBe(7);
    expect(result.unpaidAbsenceDays).toBe(0);
    expect(result.deduction).toBe(0);
    expect(result.netPayable).toBe(3100);
  });

  it("deducts one day's salary for every absence beyond the allowance", () => {
    const result = computePayroll({
      period: "2026-01",
      monthlySalary: 3100,
      weeklyRestDay: 5,
      records: absences(7),
    });
    const oneMore = computePayroll({
      period: "2026-01",
      monthlySalary: 3100,
      weeklyRestDay: 5,
      records: absences(8),
    });
    expect(result.dailyRate).toBe(100);
    expect(oneMore.unpaidAbsenceDays).toBe(1);
    expect(oneMore.deduction).toBe(100);
    expect(oneMore.netPayable).toBe(3000);
  });

  it("uses the number of calendar days in the month as the daily rate base", () => {
    const february = computePayroll({
      period: "2026-02",
      monthlySalary: 2800,
      weeklyRestDay: 5,
      records: absences(12, "2026-02"),
    });
    expect(february.calendarDays).toBe(28);
    expect(february.dailyRate).toBe(100);
    expect(february.unpaidAbsenceDays).toBe(5);
    expect(february.deduction).toBe(500);
    expect(february.netPayable).toBe(2300);

    const april = computePayroll({
      period: "2026-04",
      monthlySalary: 3000,
      weeklyRestDay: 5,
      records: absences(8, "2026-04"),
    });
    expect(april.calendarDays).toBe(30);
    expect(april.dailyRate).toBe(100);
    expect(april.deduction).toBe(100);
  });

  it("never returns a negative payable salary", () => {
    // Allowance 0 + every working day absent is the worst case the rules allow.
    const result = computePayroll({
      period: "2026-04",
      monthlySalary: 200,
      weeklyRestDay: 5,
      allowanceDays: 0,
      records: absences(30, "2026-04"),
    });
    expect(result.netPayable).toBeGreaterThanOrEqual(0);
    expect(result.deduction).toBeLessThanOrEqual(result.monthlySalary);
  });

  it("excludes approved leave, rest days and holidays from absences", () => {
    const result = computePayroll({
      period: "2026-01",
      monthlySalary: 3100,
      weeklyRestDay: 5,
      records: [
        ...absences(8),
        { dateKey: "2026-01-20", status: "leave" as const },
        { dateKey: "2026-01-21", status: "rest" as const },
        { dateKey: "2026-01-22", status: "holiday" as const },
      ],
    });
    expect(result.absentDays).toBe(8);
    expect(result.leaveDays).toBe(1);
    expect(result.restDays).toBe(2);
    expect(result.unpaidAbsenceDays).toBe(1);
    expect(result.deduction).toBe(100);
  });

  it("ignores records that fall on the weekly rest day", () => {
    // 2026-01-02 and 2026-01-09 are Fridays.
    const result = computePayroll({
      period: "2026-01",
      monthlySalary: 3100,
      weeklyRestDay: 5,
      records: [
        { dateKey: "2026-01-02", status: "absent" as const },
        { dateKey: "2026-01-09", status: "absent" as const },
      ],
    });
    expect(result.absentDays).toBe(0);
    expect(result.deduction).toBe(0);
  });

  it("ignores records from another month and counts a duplicated day once", () => {
    const result = computePayroll({
      period: "2026-01",
      monthlySalary: 3100,
      weeklyRestDay: 5,
      records: [
        ...absences(7),
        { dateKey: "2025-12-31", status: "absent" as const },
        { dateKey: "2026-01-01", status: "absent" as const },
        { dateKey: "2026-01-01", status: "leave" as const },
      ],
    });
    expect(result.absentDays).toBe(6);
    expect(result.leaveDays).toBe(1);
  });

  it("honours a configured allowance of zero", () => {
    const result = computePayroll({
      period: "2026-01",
      monthlySalary: 3100,
      weeklyRestDay: 5,
      allowanceDays: 0,
      records: absences(1),
    });
    expect(result.unpaidAbsenceDays).toBe(1);
    expect(result.deduction).toBe(100);
  });

  it("counts weekly rest days for the calendar", () => {
    const month = parsePeriod("2026-01")!;
    // January 2026 has five Fridays (2, 9, 16, 23, 30).
    expect(countWeeklyRestDays(month, 5)).toBe(5);
    expect(countWeeklyRestDays(month, 0)).toBe(4); // four Sundays in Jan 2026
  });
});

describe("date helpers", () => {
  it("round-trips a local date key", () => {
    const date = parseDateKey("2026-03-09");
    expect(date).not.toBeNull();
    expect(dateKeyOf(date!)).toBe("2026-03-09");
  });

  it("rejects impossible dates", () => {
    expect(parseDateKey("2026-02-30")).toBeNull();
    expect(parseDateKey("09-03-2026")).toBeNull();
  });

  it("lists every day of the month", () => {
    const keys = monthDateKeys("2026-02");
    expect(keys).toHaveLength(28);
    expect(keys[0]).toBe("2026-02-01");
    expect(keys[27]).toBe("2026-02-28");
  });
});
