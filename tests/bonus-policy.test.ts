import { describe, expect, it } from "vitest";
import { round2 } from "../src/lib/commerce";
import {
  DEFAULT_CUSTOMER_BONUS_POLICY,
  DEFAULT_EMPLOYEE_BENEFIT_POLICY,
  allocatePayrollDeduction,
  bonusExpiryDate,
  checkEmployeeMonthlyLimit,
  computeBonusRedemptionLimit,
  computeCustomerBonus,
  computeEmployeeBenefit,
  eligibleBonusBase,
  isBonusEntryExpired,
  resolveCustomerBonusPercent,
  resolveEmployeeBenefitPercent,
  sameTransactionSpendable,
  splitDeductionAcrossPurchases,
  type BonusLineForEligibility,
  type CustomerBonusPolicy,
  type EmployeeBenefitPolicy,
} from "../src/lib/bonus-policy";

const line = (over: Partial<BonusLineForEligibility> = {}): BonusLineForEligibility => ({
  subtotal: 1000,
  discount: 0,
  itemType: "inventory",
  pricingMode: "retail",
  categoryId: "cat-1",
  ...over,
});

const bonusPolicy = (over: Partial<CustomerBonusPolicy> = {}): CustomerBonusPolicy => ({
  ...DEFAULT_CUSTOMER_BONUS_POLICY,
  ...over,
});

const employeePolicy = (over: Partial<EmployeeBenefitPolicy> = {}): EmployeeBenefitPolicy => ({
  ...DEFAULT_EMPLOYEE_BENEFIT_POLICY,
  ...over,
});

describe("customer bonus earning", () => {
  it("uses the customer's own rate, else the shop default", () => {
    expect(resolveCustomerBonusPercent(5, 2)).toBe(5);
    expect(resolveCustomerBonusPercent(null, 2)).toBe(2);
    expect(resolveCustomerBonusPercent(0, 2)).toBe(2);
    expect(resolveCustomerBonusPercent(null, 0)).toBe(0);
  });

  it("earns the configured percentage on eligible merchandise (5,000 → 100 at 2%)", () => {
    const result = computeCustomerBonus({
      customerBonusPercent: null,
      lines: [line({ subtotal: 5000 })],
      saleTotal: 5000,
      paymentMethods: ["cash"],
      policy: bonusPolicy(),
    });
    expect(result.earned).toBe(100);
    expect(result.reason).toBeNull();
  });

  it("earns on the net value after line discounts", () => {
    const result = computeCustomerBonus({
      customerBonusPercent: 10,
      lines: [line({ subtotal: 1000, discount: 200 })],
      saleTotal: 800,
      paymentMethods: ["cash"],
      policy: bonusPolicy(),
    });
    expect(result.eligibleBase).toBe(800);
    expect(result.earned).toBe(80);
  });

  it("excludes wholesale, direct and excluded-category lines when the policy says so", () => {
    const policy = bonusPolicy({ wholesaleQualifies: false, directQualifies: false, excludedCategoryIds: ["cat-x"] });
    const base = eligibleBonusBase(
      [
        line({ subtotal: 1000 }),
        line({ subtotal: 500, pricingMode: "wholesale" }),
        line({ subtotal: 300, itemType: "direct" }),
        line({ subtotal: 700, categoryId: "cat-x" }),
      ],
      policy
    );
    expect(base).toBe(1000);
  });

  it("honours wholesale lines when the policy allows them", () => {
    const policy = bonusPolicy({ wholesaleQualifies: true });
    expect(eligibleBonusBase([line({ subtotal: 500, pricingMode: "wholesale" })], policy)).toBe(500);
  });

  it("applies the minimum purchase, ineligible tenders, and the enable switch", () => {
    const belowMin = computeCustomerBonus({
      customerBonusPercent: null,
      lines: [line({ subtotal: 900 })],
      saleTotal: 900,
      paymentMethods: ["cash"],
      policy: bonusPolicy({ minPurchaseAmount: 1000 }),
    });
    expect(belowMin.earned).toBe(0);
    expect(belowMin.reason).toContain("Minimum purchase");

    const wrongTender = computeCustomerBonus({
      customerBonusPercent: null,
      lines: [line({ subtotal: 2000 })],
      saleTotal: 2000,
      paymentMethods: ["exchange"],
      policy: bonusPolicy({ eligiblePaymentMethods: ["cash"] }),
    });
    expect(wrongTender.earned).toBe(0);
    expect(wrongTender.reason).toContain("Payment method");

    const disabled = computeCustomerBonus({
      customerBonusPercent: 5,
      lines: [line({ subtotal: 2000 })],
      saleTotal: 2000,
      paymentMethods: ["cash"],
      policy: bonusPolicy({ enabled: false }),
    });
    expect(disabled.earned).toBe(0);
  });
});

describe("customer bonus redemption limits", () => {
  it("caps redemption at the configured share of the bill", () => {
    const result = computeBonusRedemptionLimit({
      enabled: true,
      balance: 5000,
      saleTotal: 3000,
      maxPercent: 20,
      minRedeemBalance: 0,
      policy: bonusPolicy(),
    });
    // 20% of 3,000 = 600, not the whole 5,000 balance
    expect(result.max).toBe(600);
  });

  it("never exceeds the customer's balance (3,000 bill, 500 balance)", () => {
    const result = computeBonusRedemptionLimit({
      enabled: true,
      balance: 500,
      saleTotal: 3000,
      maxPercent: 100,
      minRedeemBalance: 0,
      policy: bonusPolicy(),
    });
    expect(result.max).toBe(500);
  });

  it("never exceeds the bill itself", () => {
    const result = computeBonusRedemptionLimit({
      enabled: true,
      balance: 5000,
      saleTotal: 300,
      maxPercent: 100,
      minRedeemBalance: 0,
      policy: bonusPolicy(),
    });
    expect(result.max).toBe(300);
  });

  it("blocks redemption below the minimum balance, when disabled, or with no balance", () => {
    expect(
      computeBonusRedemptionLimit({
        enabled: true,
        balance: 100,
        saleTotal: 5000,
        maxPercent: 50,
        minRedeemBalance: 200,
        policy: bonusPolicy(),
      }).max
    ).toBe(0);

    expect(
      computeBonusRedemptionLimit({
        enabled: false,
        balance: 400,
        saleTotal: 5000,
        maxPercent: 50,
        minRedeemBalance: 0,
        policy: bonusPolicy(),
      }).max
    ).toBe(0);

    expect(
      computeBonusRedemptionLimit({
        enabled: true,
        balance: 0,
        saleTotal: 5000,
        maxPercent: 50,
        minRedeemBalance: 0,
        policy: bonusPolicy(),
      }).max
    ).toBe(0);
  });

  it("only spends the bonus earned on this sale when same-transaction redemption is on", () => {
    expect(sameTransactionSpendable(100, bonusPolicy({ sameTransactionRedeem: false }))).toBe(0);
    expect(sameTransactionSpendable(100, bonusPolicy({ sameTransactionRedeem: true }))).toBe(100);

    const withSameTransaction = computeBonusRedemptionLimit({
      enabled: true,
      balance: 100,
      saleTotal: 1000,
      maxPercent: 100,
      minRedeemBalance: 0,
      earnedThisSale: 100,
      policy: bonusPolicy({ sameTransactionRedeem: true }),
    });
    expect(withSameTransaction.max).toBe(200);
  });
});

describe("bonus expiry", () => {
  it("never expires without a period, and computes the expiry date otherwise", () => {
    const earnedAt = new Date("2026-01-01T00:00:00.000Z");
    expect(bonusExpiryDate(earnedAt, 0)).toBeNull();
    expect(bonusExpiryDate(earnedAt, -5)).toBeNull();
    expect(bonusExpiryDate(earnedAt, 30)?.getTime()).toBeGreaterThan(earnedAt.getTime());
  });

  it("detects an expired earning row exactly once the moment passes", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    expect(isBonusEntryExpired(null, now)).toBe(false);
    expect(isBonusEntryExpired(new Date("2026-06-15T11:59:59.999Z"), now)).toBe(true);
    expect(isBonusEntryExpired(new Date("2026-06-15T12:00:00.001Z"), now)).toBe(false);
  });
});

describe("employee purchase benefit", () => {
  it("resolves the rate: employee override, then department, then shop default", () => {
    expect(resolveEmployeeBenefitPercent({ employeePercent: 8, departmentPercent: 6, defaultPercent: 5 })).toBe(8);
    expect(resolveEmployeeBenefitPercent({ employeePercent: null, departmentPercent: 6, defaultPercent: 5 })).toBe(6);
    expect(resolveEmployeeBenefitPercent({ employeePercent: null, departmentPercent: null, defaultPercent: 5 })).toBe(5);
    expect(resolveEmployeeBenefitPercent({ employeePercent: 0, departmentPercent: 0, defaultPercent: 0 })).toBe(0);
  });

  it("gives 5% of 10,000 as benefit and keeps the employee owing 9,500", () => {
    const result = computeEmployeeBenefit({
      employeePercent: 5,
      lines: [line({ subtotal: 10000 })],
      policy: employeePolicy({ defaultPercent: 5 }),
    });
    expect(result.benefit).toBe(500);
    expect(result.net).toBe(9500);
  });

  it("supports a fixed benefit that can never exceed the purchase", () => {
    const capped = computeEmployeeBenefit({
      lines: [line({ subtotal: 300 })],
      policy: employeePolicy({ mode: "fixed", fixedAmount: 500 }),
    });
    expect(capped.benefit).toBe(300);
    expect(capped.net).toBe(0);

    const normal = computeEmployeeBenefit({
      lines: [line({ subtotal: 4000 })],
      policy: employeePolicy({ mode: "fixed", fixedAmount: 500 }),
    });
    expect(normal.benefit).toBe(500);
    expect(normal.net).toBe(3500);
  });

  it("skips wholesale and excluded-category lines unless allowed", () => {
    const strict = computeEmployeeBenefit({
      employeePercent: 10,
      lines: [line({ subtotal: 1000 }), line({ subtotal: 400, pricingMode: "wholesale" }), line({ subtotal: 600, categoryId: "cat-x" })],
      policy: employeePolicy({ wholesaleAllowed: false, excludedCategoryIds: ["cat-x"] }),
    });
    expect(strict.eligibleBase).toBe(1000);
    expect(strict.benefit).toBe(100);

    const lenient = computeEmployeeBenefit({
      employeePercent: 10,
      lines: [line({ subtotal: 1000 }), line({ subtotal: 400, pricingMode: "wholesale" })],
      policy: employeePolicy({ wholesaleAllowed: true }),
    });
    expect(lenient.eligibleBase).toBe(1400);
    expect(lenient.benefit).toBe(140);
    expect(lenient.net).toBe(1260);
  });

  it("records no benefit while the feature is switched off", () => {
    const result = computeEmployeeBenefit({
      employeePercent: 10,
      lines: [line({ subtotal: 1000 })],
      policy: employeePolicy({ enabled: false }),
    });
    expect(result.benefit).toBe(0);
    expect(result.net).toBe(1000);
  });

  it("enforces the monthly purchase limit (0 = unlimited)", () => {
    expect(checkEmployeeMonthlyLimit({ policy: employeePolicy({ maxMonthlyPurchase: 0 }), alreadyBoughtThisMonth: 99999, newNetAmount: 5000 })).toBeNull();
    expect(
      checkEmployeeMonthlyLimit({
        policy: employeePolicy({ maxMonthlyPurchase: 10000 }),
        alreadyBoughtThisMonth: 4000,
        newNetAmount: 9500,
      })
    ).toContain("exceeds");
    expect(
      checkEmployeeMonthlyLimit({
        policy: employeePolicy({ maxMonthlyPurchase: 10000 }),
        alreadyBoughtThisMonth: 4000,
        newNetAmount: 6000,
      })
    ).toBeNull();
  });
});

describe("payroll deduction of employee purchases", () => {
  it("deducts only what is owed, capped by the monthly limit and remaining salary", () => {
    expect(
      allocatePayrollDeduction({ outstanding: 3000, alreadyDeductedThisPeriod: 0, maxMonthlyDeduction: 0, netSalary: 30000 })
    ).toBe(3000);

    // Monthly cap leaves only 1,500 of the 3,000 outstanding
    expect(
      allocatePayrollDeduction({ outstanding: 3000, alreadyDeductedThisPeriod: 2500, maxMonthlyDeduction: 4000, netSalary: 30000 })
    ).toBe(1500);

    // Never more than the salary left after attendance
    expect(
      allocatePayrollDeduction({ outstanding: 5000, alreadyDeductedThisPeriod: 0, maxMonthlyDeduction: 0, netSalary: 2000 })
    ).toBe(2000);

    // Already fully deducted this period → nothing more
    expect(
      allocatePayrollDeduction({ outstanding: 500, alreadyDeductedThisPeriod: 500, maxMonthlyDeduction: 500, netSalary: 30000 })
    ).toBe(0);
  });

  it("splits the deduction across purchases oldest-first, without ever overdrawing", () => {
    const split = splitDeductionAcrossPurchases(
      [
        { id: "old", outstanding: 1000 },
        { id: "mid", outstanding: 800 },
        { id: "new", outstanding: 500 },
      ],
      1300
    );
    expect(split).toEqual([
      { id: "old", amount: 1000 },
      { id: "mid", amount: 300 },
    ]);
    expect(split.reduce((s, r) => s + r.amount, 0)).toBe(1300);
  });

  it("never allocates more than a purchase's outstanding balance", () => {
    const split = splitDeductionAcrossPurchases([{ id: "a", outstanding: 250 }], 5000);
    expect(split).toEqual([{ id: "a", amount: 250 }]);
    expect(splitDeductionAcrossPurchases([{ id: "a", outstanding: 250 }], 0)).toEqual([]);
  });

  it("rounds money to two decimals (no floating-point drift)", () => {
    const split = splitDeductionAcrossPurchases(
      [
        { id: "a", outstanding: 0.1 },
        { id: "b", outstanding: 0.2 },
      ],
      0.3
    );
    // Every stored amount is already two-decimal money; totals are summed the
    // same way the app does it (round2), so the ledger adds up exactly.
    expect(split.map((r) => r.amount)).toEqual([0.1, 0.2]);
    expect(round2(split.reduce((s, r) => s + r.amount, 0))).toBe(0.3);
  });
});
