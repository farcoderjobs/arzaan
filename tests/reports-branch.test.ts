import { describe, it, expect } from "vitest";
import { parseReportRange, parsePage, escapeRegex } from "../src/lib/reports";
import { branchScope, assertBranchAccess, canAccessBranch, BranchAccessError } from "../src/lib/branch-access";

describe("parseReportRange (date filtering)", () => {
  it("day period starts at UTC midnight", () => {
    const r = parseReportRange(new URLSearchParams("period=day"));
    const start = r.from;
    expect(start.getUTCHours()).toBe(0);
    expect(start.getUTCMinutes()).toBe(0);
    expect(start.getUTCSeconds()).toBe(0);
    expect(r.to >= r.from).toBe(true);
  });

  it("week period covers the last 7 days", () => {
    const r = parseReportRange(new URLSearchParams("period=week"));
    const days = (r.to.getTime() - r.from.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(6);
    expect(days).toBeLessThan(7.01);
  });

  it("month period starts on the 1st", () => {
    const r = parseReportRange(new URLSearchParams("period=month"));
    expect(r.from.getUTCDate()).toBe(1);
  });

  it("custom range parses from/to params", () => {
    const r = parseReportRange(new URLSearchParams("from=2026-01-01&to=2026-01-31"));
    expect(r.from.getUTCFullYear()).toBe(2026);
    expect(r.from.getUTCMonth()).toBe(0);
  });

  it("end of custom range is exclusive of the next day (inclusive day end)", () => {
    const r = parseReportRange(new URLSearchParams("from=2026-01-01&to=2026-01-01"));
    // to should cover the whole first day (23:59:59.999) not midnight
    expect(r.to.getUTCHours()).toBe(23);
    expect(r.to.getUTCMinutes()).toBe(59);
  });

  it("falls back to last 30 days without params", () => {
    const r = parseReportRange(new URLSearchParams(""));
    const days = (r.to.getTime() - r.from.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(28);
    expect(days).toBeLessThan(31);
  });
});

describe("parsePage", () => {
  it("defaults to page 1", () => {
    expect(parsePage(new URLSearchParams(""))).toMatchObject({ page: 1 });
  });

  it("clamps non-positive pages", () => {
    expect(parsePage(new URLSearchParams("page=0")).page).toBe(1);
    expect(parsePage(new URLSearchParams("page=-3")).page).toBe(1);
  });

  it("computes skip for pagination", () => {
    const p = parsePage(new URLSearchParams("page=3&perPage=20"));
    expect(p.page).toBe(3);
    expect(p.skip).toBe(40);
  });
});

describe("escapeRegex (MongoDB injection guard for regex queries)", () => {
  it("escapes regex metacharacters", () => {
    const escaped = escapeRegex("a.b*c?d");
    // Every metacharacter must be backslash-escaped
    for (const ch of [".", "*", "?"]) {
      expect(escaped).toContain("\\" + ch);
    }
  });

  it("neutralizes $regex injection attempts", () => {
    const escaped = escapeRegex('^.*$');
    const re = new RegExp(escaped);
    // A literal ".*" string should NOT match arbitrary text anymore
    expect(re.test("anything")).toBe(false);
    expect(re.test("^.*$")).toBe(true);
  });
});

describe("branchScope (branch isolation)", () => {
  it("HQ users (branchId null) get unrestricted scope", () => {
    expect(branchScope({ branchId: null })).toEqual({});
  });

  it("branch users are scoped to their branch ObjectId", () => {
    const scope = branchScope({ branchId: "507f1f77bcf86cd799439011" });
    expect(scope).toHaveProperty("branchId");
  });
});

describe("canAccessBranch", () => {
  it("HQ user can access any branch", () => {
    expect(canAccessBranch({ branchId: null }, "507f1f77bcf86cd799439011")).toBe(true);
    expect(canAccessBranch({ branchId: null }, null)).toBe(true);
  });

  it("branch user cannot access another branch", () => {
    expect(
      canAccessBranch({ branchId: "507f1f77bcf86cd799439011" }, "507f1f77bcf86cd799439022")
    ).toBe(false);
  });

  it("branch user can access their own branch", () => {
    expect(
      canAccessBranch({ branchId: "507f1f77bcf86cd799439011" }, "507f1f77bcf86cd799439011")
    ).toBe(true);
  });
});

describe("assertBranchAccess (IDOR guard)", () => {
  it("throws BranchAccessError for foreign-branch docs", () => {
    expect(() =>
      assertBranchAccess({ branchId: "507f1f77bcf86cd799439011" }, "507f1f77bcf86cd799439022")
    ).toThrow(BranchAccessError);
  });

  it("passes for same branch and for HQ users", () => {
    expect(() =>
      assertBranchAccess({ branchId: "507f1f77bcf86cd799439011" }, "507f1f77bcf86cd799439011")
    ).not.toThrow();
    expect(() =>
      assertBranchAccess({ branchId: null }, "507f1f77bcf86cd799439022")
    ).not.toThrow();
  });
});
