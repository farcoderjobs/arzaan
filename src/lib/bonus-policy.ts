import { round2 } from "@/lib/commerce";

/**
 * Pure loyalty-bonus and employee-purchase-benefit rules.
 *
 * Everything here is deterministic and database-free so the POS, the API, the
 * payroll run and the tests all apply exactly the same arithmetic:
 *
 *  Customer bonus
 *   - rate = the customer's own percentage, else the shop default;
 *   - only eligible merchandise earns (category exclusions, wholesale/direct
 *     opt-in, minimum purchase value);
 *   - the redemption cap is the lowest of: available balance, the configured
 *     share of the bill, and the bill itself;
 *   - bonus earned on this sale is spendable on this sale only when the shop
 *     explicitly allows same-transaction redemption.
 *
 *  Employee purchase benefit
 *   - the benefit is employer-funded, so it is a discount, never salary debt;
 *   - the employee owes the NET amount (gross − benefit);
 *   - a fixed-amount benefit can never exceed the eligible value;
 *   - payroll recovers at most the outstanding amount, the monthly cap and the
 *     employee's remaining payable salary.
 */

export type BonusLineForEligibility = {
  /** Line value before line discount(s). */
  subtotal: number;
  /** Discount already applied to this line (amount). */
  discount: number;
  itemType: "inventory" | "direct";
  pricingMode: "retail" | "wholesale";
  categoryId?: string | null;
};

export type CustomerBonusPolicy = {
  enabled: boolean;
  defaultPercent: number;
  minPurchaseAmount: number;
  minRedeemBalance: number;
  eligiblePaymentMethods: string[];
  wholesaleQualifies: boolean;
  directQualifies: boolean;
  excludedCategoryIds: string[];
  expiryDays: number;
  sameTransactionRedeem: boolean;
  restoreRedeemedOnRefund: boolean;
};

export const DEFAULT_CUSTOMER_BONUS_POLICY: CustomerBonusPolicy = {
  enabled: true,
  defaultPercent: 2,
  minPurchaseAmount: 0,
  minRedeemBalance: 0,
  eligiblePaymentMethods: ["cash", "card", "transfer", "credit"],
  wholesaleQualifies: false,
  directQualifies: true,
  excludedCategoryIds: [],
  expiryDays: 0,
  sameTransactionRedeem: false,
  restoreRedeemedOnRefund: true,
};

export function parseCsv(value: string | null | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function normalizeMethods(value: string | string[] | null | undefined): string[] {
  const list = Array.isArray(value) ? value : parseCsv(value);
  return [...new Set(list.map((m) => m.trim().toLowerCase()).filter(Boolean))];
}

/** Customer rate: their own percentage wins, else the shop default. */
export function resolveCustomerBonusPercent(
  customerPercent: number | null | undefined,
  defaultPercent: number
): number {
  const own = Number(customerPercent ?? 0);
  if (Number.isFinite(own) && own > 0) return Math.min(100, own);
  const fallback = Number(defaultPercent ?? 0);
  return Number.isFinite(fallback) && fallback > 0 ? Math.min(100, fallback) : 0;
}

/** Value of the lines that may earn bonus, after line discounts. */
export function eligibleBonusBase(
  lines: BonusLineForEligibility[],
  policy: Pick<CustomerBonusPolicy, "wholesaleQualifies" | "directQualifies" | "excludedCategoryIds">
): number {
  const excluded = new Set(policy.excludedCategoryIds);
  let base = 0;
  for (const line of lines) {
    if (line.itemType === "direct" && !policy.directQualifies) continue;
    if (line.pricingMode === "wholesale" && !policy.wholesaleQualifies) continue;
    if (line.categoryId && excluded.has(line.categoryId)) continue;
    base += Math.max(0, Number(line.subtotal) - Number(line.discount));
  }
  return round2(base);
}

export type CustomerBonusEarnResult = {
  percent: number;
  eligibleBase: number;
  earned: number;
  /** Why no bonus was earned (null when earned > 0 is not required — 0 is fine). */
  reason: string | null;
};

export function computeCustomerBonus(input: {
  customerBonusPercent: number | null | undefined;
  lines: BonusLineForEligibility[];
  /** Sale total after every discount (used for the minimum-purchase rule). */
  saleTotal: number;
  paymentMethods: string[];
  policy: CustomerBonusPolicy;
}): CustomerBonusEarnResult {
  const percent = resolveCustomerBonusPercent(input.customerBonusPercent, input.policy.defaultPercent);
  if (!input.policy.enabled) return { percent, eligibleBase: 0, earned: 0, reason: "Customer bonus is disabled" };
  if (percent <= 0) return { percent: 0, eligibleBase: 0, earned: 0, reason: "No bonus rate is configured" };

  const eligibleBase = eligibleBonusBase(input.lines, input.policy);
  if (eligibleBase <= 0) return { percent, eligibleBase: 0, earned: 0, reason: "No eligible merchandise" };

  if (input.policy.minPurchaseAmount > 0 && input.saleTotal + 0.001 < input.policy.minPurchaseAmount) {
    return {
      percent,
      eligibleBase,
      earned: 0,
      reason: `Minimum purchase for bonus is ${input.policy.minPurchaseAmount}`,
    };
  }

  const allowedMethods = new Set(normalizeMethods(input.policy.eligiblePaymentMethods));
  if (allowedMethods.size > 0 && !input.paymentMethods.some((m) => allowedMethods.has(m))) {
    return { percent, eligibleBase, earned: 0, reason: "Payment method is not bonus-eligible" };
  }

  return { percent, eligibleBase, earned: round2((eligibleBase * percent) / 100), reason: null };
}

/**
 * Bonus earned on this sale may only be spent here when same-transaction
 * redemption is allowed; otherwise only the pre-sale balance is spendable.
 */
export function sameTransactionSpendable(earnedThisSale: number, policy: CustomerBonusPolicy): number {
  return policy.sameTransactionRedeem ? Math.max(0, round2(earnedThisSale)) : 0;
}

export type BonusRedemptionResult = {
  /** Maximum amount that may be tendered from the bonus ledger. */
  max: number;
  available: number;
  reason: string | null;
};

export function computeBonusRedemptionLimit(input: {
  enabled: boolean;
  balance: number;
  saleTotal: number;
  maxPercent: number;
  minRedeemBalance: number;
  earnedThisSale?: number;
  policy: CustomerBonusPolicy;
}): BonusRedemptionResult {
  const balance = Math.max(0, round2(input.balance));
  if (!input.enabled) return { max: 0, available: balance, reason: "Redemption is disabled" };
  if (balance <= 0) return { max: 0, available: 0, reason: "No bonus balance" };
  if (balance + 0.001 < input.minRedeemBalance) {
    return {
      max: 0,
      available: balance,
      reason: `Minimum bonus balance for redemption is ${input.minRedeemBalance}`,
    };
  }
  const spendable = round2(balance + sameTransactionSpendable(input.earnedThisSale ?? 0, input.policy));
  const percentCap = round2((Math.max(0, input.saleTotal) * Math.min(100, Math.max(0, input.maxPercent))) / 100);
  const max = Math.max(0, Math.min(spendable, percentCap, Math.max(0, round2(input.saleTotal))));
  return { max, available: balance, reason: null };
}

export type EmployeeBenefitPolicy = {
  enabled: boolean;
  defaultPercent: number;
  mode: "percent" | "fixed";
  fixedAmount: number;
  wholesaleAllowed: boolean;
  creditAllowed: boolean;
  deductionMode: "payroll" | "immediate";
  maxMonthlyPurchase: number;
  maxMonthlyDeduction: number;
  excludedCategoryIds: string[];
};

export const DEFAULT_EMPLOYEE_BENEFIT_POLICY: EmployeeBenefitPolicy = {
  enabled: true,
  defaultPercent: 5,
  mode: "percent",
  fixedAmount: 0,
  wholesaleAllowed: false,
  creditAllowed: true,
  deductionMode: "payroll",
  maxMonthlyPurchase: 0,
  maxMonthlyDeduction: 0,
  excludedCategoryIds: [],
};

/** Employee rate: personal override, then department, then shop default. */
export function resolveEmployeeBenefitPercent(input: {
  employeePercent?: number | null;
  departmentPercent?: number | null;
  defaultPercent: number;
}): number {
  for (const candidate of [input.employeePercent, input.departmentPercent, input.defaultPercent]) {
    const n = Number(candidate ?? 0);
    if (Number.isFinite(n) && n > 0) return Math.min(100, n);
  }
  return 0;
}

export type EmployeeBenefitResult = {
  percent: number;
  mode: "percent" | "fixed";
  eligibleBase: number;
  benefit: number;
  net: number;
};

export function computeEmployeeBenefit(input: {
  employeePercent?: number | null;
  departmentPercent?: number | null;
  lines: BonusLineForEligibility[];
  policy: EmployeeBenefitPolicy;
}): EmployeeBenefitResult {
  const percent = resolveEmployeeBenefitPercent({
    employeePercent: input.employeePercent,
    departmentPercent: input.departmentPercent,
    defaultPercent: input.policy.defaultPercent,
  });
  const excluded = new Set(input.policy.excludedCategoryIds);
  let base = 0;
  for (const line of input.lines) {
    if (line.pricingMode === "wholesale" && !input.policy.wholesaleAllowed) continue;
    if (line.categoryId && excluded.has(line.categoryId)) continue;
    base += Math.max(0, Number(line.subtotal) - Number(line.discount));
  }
  const eligibleBase = round2(base);

  if (!input.policy.enabled) {
    return { percent, mode: "percent", eligibleBase, benefit: 0, net: eligibleBase };
  }

  let benefit =
    input.policy.mode === "fixed"
      ? round2(Math.max(0, input.policy.fixedAmount))
      : round2((eligibleBase * percent) / 100);
  // A benefit can never make the line free-and-owed: it is capped at the base.
  benefit = Math.min(benefit, eligibleBase);
  benefit = Math.max(0, benefit);

  return {
    percent,
    mode: input.policy.mode,
    eligibleBase,
    benefit,
    net: round2(eligibleBase - benefit),
  };
}

/** Monthly purchase cap check. 0 on the policy means unlimited. */
export function employeeMonthlyRemaining(policy: EmployeeBenefitPolicy, alreadyBought: number): number {
  if (policy.maxMonthlyPurchase <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, round2(policy.maxMonthlyPurchase - Math.max(0, alreadyBought)));
}

export function checkEmployeeMonthlyLimit(input: {
  policy: EmployeeBenefitPolicy;
  alreadyBoughtThisMonth: number;
  newNetAmount: number;
  alreadyBenefitedThisMonth?: number;
}): string | null {
  const cap = input.policy.maxMonthlyPurchase;
  if (cap <= 0) return null;
  const benefited = Math.max(0, input.alreadyBenefitedThisMonth ?? input.alreadyBoughtThisMonth);
  if (round2(benefited + input.newNetAmount) > cap + 0.001) {
    return `This purchase exceeds the employee's monthly limit (${cap}). Remaining: ${round2(
      Math.max(0, cap - benefited)
    )}.`;
  }
  return null;
}

/**
 * What payroll may withhold for an employee this month.
 * Never more than what is owed, the monthly cap, or the salary left after
 * attendance deductions.
 */
export function allocatePayrollDeduction(input: {
  outstanding: number;
  alreadyDeductedThisPeriod: number;
  maxMonthlyDeduction: number;
  netSalary: number;
}): number {
  const outstanding = Math.max(0, round2(input.outstanding));
  let cap = outstanding;
  if (input.maxMonthlyDeduction > 0) {
    cap = Math.min(cap, Math.max(0, round2(input.maxMonthlyDeduction - Math.max(0, input.alreadyDeductedThisPeriod))));
  }
  return Math.max(0, Math.min(cap, Math.max(0, round2(input.netSalary))));
}

/** Splits a payroll deduction across purchases oldest-first. */
export function splitDeductionAcrossPurchases(
  purchases: Array<{ id: string; outstanding: number }>,
  amount: number
): Array<{ id: string; amount: number }> {
  let remaining = Math.max(0, round2(amount));
  const rows: Array<{ id: string; amount: number }> = [];
  for (const purchase of purchases) {
    if (remaining <= 0) break;
    const take = Math.min(Math.max(0, round2(purchase.outstanding)), remaining);
    if (take <= 0) continue;
    rows.push({ id: purchase.id, amount: take });
    remaining = round2(remaining - take);
  }
  return rows;
}

/** True when an EARN row has passed its expiry moment. */
export function isBonusEntryExpired(expiresAt: Date | string | null | undefined, now = new Date()): boolean {
  if (!expiresAt) return false;
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return Number.isFinite(at.getTime()) && at.getTime() <= now.getTime();
}

export function bonusExpiryDate(earnedAt: Date, expiryDays: number): Date | null {
  if (!Number.isFinite(expiryDays) || expiryDays <= 0) return null;
  const date = new Date(earnedAt.getTime());
  date.setDate(date.getDate() + Math.floor(expiryDays));
  return date;
}
