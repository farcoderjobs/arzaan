import mongoose from "mongoose";
import {
  EmployeePurchase,
  EmployeePurchaseDeduction,
  EmployeePurchaseLedger,
  EmployeePurchasePayment,
  User,
} from "@/models";
import { round2 } from "@/lib/commerce";
import { parsePeriod } from "@/lib/payroll";
import { getStoreSettings } from "@/lib/settings";
import { recordCashMovementIfDrawerOpen } from "@/lib/finance-service";
import {
  DEFAULT_EMPLOYEE_BENEFIT_POLICY,
  allocatePayrollDeduction,
  parseCsv,
  splitDeductionAcrossPurchases,
  type EmployeeBenefitPolicy,
} from "@/lib/bonus-policy";

/**
 * Employee purchase service.
 *
 * Rules:
 *  - The POS sale stays the source of truth for what was sold and paid; the
 *    EmployeePurchase row snapshots the benefit and the balance owed.
 *  - The benefit is an employer-funded discount. Only the NET amount can ever
 *    become salary debt.
 *  - `User.purchaseOutstanding` is the running balance; every change goes
 *    through `appendEmployeeLedger`, which is idempotent by key, so retries and
 *    cloud sync cannot double-post.
 *  - Payroll may deduct a purchase once and only once: a unique index on
 *    `employeePurchaseId` in EmployeePurchaseDeduction enforces it in MongoDB.
 */

export type EmployeePurchasePolicy = EmployeeBenefitPolicy;

export async function getEmployeeBenefitPolicy(branchId: string | null): Promise<EmployeePurchasePolicy> {
  const settings = await getStoreSettings(branchId);
  return {
    ...DEFAULT_EMPLOYEE_BENEFIT_POLICY,
    enabled: settings.employeePurchaseEnabled,
    defaultPercent: settings.employeeBenefitDefaultPercent,
    mode: settings.employeeBenefitMode,
    fixedAmount: settings.employeeBenefitFixedAmount,
    wholesaleAllowed: settings.employeeBenefitWholesaleAllowed,
    creditAllowed: settings.employeeCreditAllowed,
    deductionMode: settings.employeeDeductionMode,
    maxMonthlyPurchase: settings.employeeMaxMonthlyPurchase,
    maxMonthlyDeduction: settings.employeeMaxMonthlyDeduction,
    excludedCategoryIds: parseCsv(settings.employeeExcludedCategoryIds),
  };
}

/** `EMP-YYYY-MM-XXXXXX` — random suffix so shops/registers never collide. */
export function generateEmployeePurchaseNumber(now = new Date()): string {
  const suffix = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .toUpperCase()
    .padStart(6, "0");
  return `EMP-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${suffix}`;
}

export type EmployeeLedgerInput = {
  employeeId: string;
  branchId: string;
  employeePurchaseId: string | null;
  type: "PURCHASE" | "BENEFIT" | "PAYMENT" | "DEDUCTION" | "REFUND" | "ADJUSTMENT";
  amount: number;
  /** Signed effect on what the employee owes. */
  balanceDelta: number;
  referenceType?: "sale" | "sale_return" | "payment" | "payroll" | "adjustment" | null;
  referenceId?: string | null;
  description: string;
  idempotencyKey: string;
  userId: string;
  approvedBy?: string | null;
};

/** Atomically applies a balance change and appends one immutable ledger row. */
export async function appendEmployeeLedger(
  input: EmployeeLedgerInput,
  session?: mongoose.ClientSession | null
): Promise<{ duplicate: boolean; balanceAfter: number }> {
  const existing = await EmployeePurchaseLedger.findOne({ idempotencyKey: input.idempotencyKey })
    .session(session ?? null)
    .lean();
  if (existing) return { duplicate: true, balanceAfter: existing.balanceAfter };

  const delta = round2(input.balanceDelta);
  const employee = await User.findOneAndUpdate(
    { _id: input.employeeId },
    { $inc: { purchaseOutstanding: delta } },
    { new: true, session: session ?? undefined }
  ).lean();
  if (!employee) throw new Error("Employee not found");

  await EmployeePurchaseLedger.create(
    [
      {
        employeeId: input.employeeId,
        branchId: input.branchId,
        employeePurchaseId: input.employeePurchaseId,
        type: input.type,
        amount: round2(input.amount),
        balanceDelta: delta,
        balanceAfter: round2(employee.purchaseOutstanding ?? 0),
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        description: input.description,
        idempotencyKey: input.idempotencyKey,
        userId: input.userId,
        approvedBy: input.approvedBy ?? null,
      },
    ],
    session ? { session } : undefined
  );

  return { duplicate: false, balanceAfter: round2(employee.purchaseOutstanding ?? 0) };
}

export type CreateEmployeePurchaseInput = {
  saleId: string;
  invoiceNumber: string;
  branchId: string;
  employeeId: string;
  employeeName: string;
  departmentId: string | null;
  departmentName: string;
  cashierId: string;
  benefitMode: "percent" | "fixed";
  benefitPercent: number;
  benefitAmount: number;
  /** What the employee owes (sale total after the benefit). */
  netAmount: number;
  /** Amount actually paid at the till. */
  paidAmount: number;
};

export async function createEmployeePurchaseForSale(
  input: CreateEmployeePurchaseInput,
  session: mongoose.ClientSession
): Promise<{ id: string; outstanding: number; duplicate: boolean }> {
  const existing = await EmployeePurchase.findOne({ saleId: input.saleId }).session(session).lean();
  if (existing) {
    return { id: existing._id.toString(), outstanding: existing.outstandingAmount, duplicate: true };
  }

  const netAmount = round2(Math.max(0, input.netAmount));
  const benefitAmount = round2(Math.max(0, Math.min(input.benefitAmount, netAmount)));
  const paidAmount = round2(Math.max(0, Math.min(input.paidAmount, netAmount)));
  const outstanding = round2(Math.max(0, netAmount - paidAmount));

  const docs = await EmployeePurchase.create(
    [
      {
        purchaseNumber: generateEmployeePurchaseNumber(),
        branchId: input.branchId,
        saleId: input.saleId,
        invoiceNumber: input.invoiceNumber,
        employeeId: input.employeeId,
        employeeName: input.employeeName,
        departmentId: input.departmentId,
        departmentName: input.departmentName,
        cashierId: input.cashierId,
        benefitMode: input.benefitMode,
        benefitPercent: round2(input.benefitPercent),
        grossAmount: round2(netAmount + benefitAmount),
        benefitAmount,
        netAmount,
        paidAmount,
        outstandingAmount: outstanding,
        status: outstanding <= 0 ? "settled" : "open",
      },
    ],
    { session }
  );
  const purchase = docs[0];

  await appendEmployeeLedger(
    {
      employeeId: input.employeeId,
      branchId: input.branchId,
      employeePurchaseId: purchase._id.toString(),
      type: "PURCHASE",
      amount: netAmount,
      balanceDelta: outstanding,
      referenceType: "sale",
      referenceId: input.saleId,
      description: `Employee purchase ${input.invoiceNumber}`,
      idempotencyKey: `purchase:${purchase._id.toString()}`,
      userId: input.cashierId,
    },
    session
  );

  if (benefitAmount > 0) {
    // Informational row: the benefit is employer-funded, so it never changes
    // what the employee owes.
    await appendEmployeeLedger(
      {
        employeeId: input.employeeId,
        branchId: input.branchId,
        employeePurchaseId: purchase._id.toString(),
        type: "BENEFIT",
        amount: benefitAmount,
        balanceDelta: 0,
        referenceType: "sale",
        referenceId: input.saleId,
        description: `Employee benefit ${benefitAmount} on ${input.invoiceNumber}`,
        idempotencyKey: `purchase:${purchase._id.toString()}:benefit`,
        userId: input.cashierId,
      },
      session
    );
  }

  return { id: purchase._id.toString(), outstanding, duplicate: false };
}

export class EmployeePurchaseError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Records a payment against an employee's outstanding purchase balance. */
export async function recordEmployeePurchasePayment(input: {
  purchaseId: string;
  amount: number;
  method: string;
  reference?: string;
  userId: string;
  idempotencyKey?: string;
}): Promise<{ paidAmount: number; outstandingAmount: number; status: string }> {
  const purchase = await EmployeePurchase.findById(input.purchaseId);
  if (!purchase) throw new EmployeePurchaseError("NOT_FOUND", "Employee purchase not found");

  const amount = round2(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new EmployeePurchaseError("INVALID_AMOUNT", "Payment must be greater than zero");
  }
  const outstanding = round2(Math.max(0, purchase.outstandingAmount));
  if (outstanding <= 0) throw new EmployeePurchaseError("SETTLED", "This purchase is already settled");
  if (amount > outstanding + 0.001) {
    throw new EmployeePurchaseError("OVERPAYMENT", `Payment exceeds the outstanding balance (${outstanding})`);
  }

  const key = input.idempotencyKey?.trim() || `payment:${purchase._id.toString()}:${new mongoose.Types.ObjectId().toString()}`;
  const duplicate = await EmployeePurchasePayment.findOne({ idempotencyKey: key }).lean();
  if (duplicate) {
    return {
      paidAmount: purchase.paidAmount,
      outstandingAmount: purchase.outstandingAmount,
      status: purchase.status,
    };
  }

  await EmployeePurchasePayment.create({
    employeePurchaseId: purchase._id,
    employeeId: purchase.employeeId,
    branchId: purchase.branchId,
    amount,
    method: input.method || "cash",
    reference: input.reference ?? "",
    userId: input.userId,
    idempotencyKey: key,
  });

  purchase.paidAmount = round2(purchase.paidAmount + amount);
  purchase.outstandingAmount = round2(Math.max(0, purchase.outstandingAmount - amount));
  if (purchase.outstandingAmount <= 0) purchase.status = "settled";
  await purchase.save();

  await appendEmployeeLedger({
    employeeId: purchase.employeeId.toString(),
    branchId: purchase.branchId.toString(),
    employeePurchaseId: purchase._id.toString(),
    type: "PAYMENT",
    amount,
    balanceDelta: -amount,
    referenceType: "payment",
    referenceId: null,
    description: `Employee payment of ${amount} on ${purchase.purchaseNumber}`,
    idempotencyKey: `${key}:ledger`,
    userId: input.userId,
  });

  // A cash payment is real drawer money: record it so Finance > Cash
  // Transactions and the register agree with the Employee purchases report.
  if ((input.method || "cash") === "cash") {
    await recordCashMovementIfDrawerOpen({
      userId: input.userId,
      branchId: purchase.branchId.toString(),
      type: "payment_in",
      amount,
      description: `Employee purchase payment ${purchase.purchaseNumber} — ${purchase.employeeName}`,
      referenceType: "income",
      referenceId: purchase._id.toString(),
    });
  }

  // Keep the denormalised running balance exact (the POS employee picker and
  // the employee list read it): it is always the sum of open purchases, so a
  // settled purchase can never keep showing as payable.
  const [openBalance] = await EmployeePurchase.aggregate<{ total: number }>([
    {
      $match: {
        employeeId: purchase.employeeId,
        status: { $in: ["open", "settled", "deducted"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$outstandingAmount" } } },
  ]);
  await User.updateOne(
    { _id: purchase.employeeId },
    { $set: { purchaseOutstanding: round2(openBalance?.total ?? 0) } }
  );

  return {
    paidAmount: purchase.paidAmount,
    outstandingAmount: purchase.outstandingAmount,
    status: purchase.status,
  };
}

/**
 * Reduces what an employee owes after a return. The returned value is taken
 * off the outstanding balance; if payroll already recovered the purchase, the
 * balance goes negative, which is a credit the next payroll period carries
 * forward rather than silently rewriting finalized payroll.
 */
export async function applyEmployeePurchaseReturn(input: {
  saleId: string;
  refundAmount: number;
  returnId: string;
  userId: string;
  approvedBy?: string | null;
}): Promise<{ adjusted: number; outstanding: number } | null> {
  const purchase = await EmployeePurchase.findOne({ saleId: input.saleId });
  if (!purchase) return null;

  const amount = round2(Math.max(0, Math.min(input.refundAmount, purchase.outstandingAmount)));
  if (amount <= 0) return { adjusted: 0, outstanding: purchase.outstandingAmount };

  purchase.outstandingAmount = round2(purchase.outstandingAmount - amount);
  if (purchase.outstandingAmount <= 0 && purchase.status === "open") purchase.status = "settled";
  await purchase.save();

  await appendEmployeeLedger({
    employeeId: purchase.employeeId.toString(),
    branchId: purchase.branchId.toString(),
    employeePurchaseId: purchase._id.toString(),
    type: "REFUND",
    amount,
    balanceDelta: -amount,
    referenceType: "sale_return",
    referenceId: input.returnId,
    description: `Return against employee purchase ${purchase.purchaseNumber}`,
    idempotencyKey: `purchase:${purchase._id.toString()}:return:${input.returnId}`,
    userId: input.userId,
    approvedBy: input.approvedBy ?? null,
  });

  return { adjusted: amount, outstanding: purchase.outstandingAmount };
}

/** Net purchases an employee made in one calendar month (for the monthly cap). */
export async function employeeMonthlyPurchaseTotal(employeeId: string, period: string): Promise<number> {
  const month = parsePeriod(period);
  if (!month) return 0;
  const rows = await EmployeePurchase.aggregate<{ total: number }>([
    {
      $match: {
        employeeId: new mongoose.Types.ObjectId(employeeId),
        status: { $ne: "canceled" },
        createdAt: { $gte: month.start, $lt: month.endExclusive },
      },
    },
    { $group: { _id: null, total: { $sum: "$netAmount" } } },
  ]);
  return round2(rows[0]?.total ?? 0);
}

export function periodOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export type PayrollPurchasePlanRow = {
  employeeId: string;
  amount: number;
  purchases: Array<{ id: string; purchaseNumber: string; amount: number }>;
};

/**
 * Decides how much of each employee's outstanding purchases the payroll may
 * recover this month. Purchases a manager excluded are skipped; every purchase
 * is consumed oldest-first and never twice (the deduction rows are unique per
 * purchase).
 */
export async function planPayrollPurchaseDeductions(input: {
  branchId: string;
  period: string;
  employees: Array<{ userId: string; netSalary: number }>;
}): Promise<Map<string, PayrollPurchasePlanRow>> {
  const month = parsePeriod(input.period);
  if (!month || input.employees.length === 0) return new Map();

  const policy = await getEmployeeBenefitPolicy(input.branchId);
  if (!policy.enabled) return new Map();

  const alreadyDeducted = await EmployeePurchaseDeduction.aggregate<{ _id: mongoose.Types.ObjectId; total: number }>([
    {
      $match: {
        period: input.period,
        branchId: new mongoose.Types.ObjectId(input.branchId),
        status: { $ne: "reversed" },
      },
    },
    { $group: { _id: "$employeeId", total: { $sum: "$amount" } } },
  ]);
  const deductedMap = new Map(alreadyDeducted.map((r) => [String(r._id), r.total]));

  const userIds = input.employees.map((e) => new mongoose.Types.ObjectId(e.userId));
  const purchases = await EmployeePurchase.find({
    branchId: new mongoose.Types.ObjectId(input.branchId),
    employeeId: { $in: userIds },
    status: { $in: ["open", "settled"] },
    outstandingAmount: { $gt: 0.001 },
    payrollExcluded: false,
    createdAt: { $lt: month.endExclusive },
  })
    .sort({ createdAt: 1 })
    .select("_id employeeId purchaseNumber outstandingAmount")
    .lean();

  const byEmployee = new Map<string, typeof purchases>();
  for (const purchase of purchases) {
    const key = String(purchase.employeeId);
    const list = byEmployee.get(key);
    if (list) list.push(purchase);
    else byEmployee.set(key, [purchase]);
  }

  const plan = new Map<string, PayrollPurchasePlanRow>();
  for (const employee of input.employees) {
    const rows = byEmployee.get(employee.userId) ?? [];
    const outstanding = round2(rows.reduce((s, r) => s + r.outstandingAmount, 0));
    if (outstanding <= 0) continue;

    const already = deductedMap.get(employee.userId) ?? 0;
    const allowed = allocatePayrollDeduction({
      outstanding,
      alreadyDeductedThisPeriod: already,
      maxMonthlyDeduction: policy.maxMonthlyDeduction,
      netSalary: employee.netSalary,
    });
    if (allowed <= 0) continue;

    const split = splitDeductionAcrossPurchases(
      rows.map((r) => ({ id: r._id.toString(), outstanding: r.outstandingAmount })),
      allowed
    );
    const numbers = new Map(rows.map((r) => [r._id.toString(), r.purchaseNumber]));
    plan.set(employee.userId, {
      employeeId: employee.userId,
      amount: round2(split.reduce((s, r) => s + r.amount, 0)),
      purchases: split.map((r) => ({ id: r.id, purchaseNumber: numbers.get(r.id) ?? "", amount: r.amount })),
    });
  }

  return plan;
}

/**
 * Creates (or replaces) the pending deduction rows for a payroll run. Called
 * while the run is still a draft, so nothing touches the employee's balance
 * until payroll is finalized.
 */
export async function stagePayrollPurchaseDeductions(input: {
  branchId: string;
  period: string;
  payrollId: string;
  entries: Array<{ userId: string; entryId: string }>;
  plan: Map<string, PayrollPurchasePlanRow>;
  userId: string;
}): Promise<void> {
  // Regenerating a draft replaces its own pending rows only; applied rows from
  // finalized months are never touched.
  const previous = await EmployeePurchaseDeduction.find({
    payrollId: input.payrollId,
    status: "pending",
  })
    .select("_id employeePurchaseId")
    .lean();
  if (previous.length > 0) {
    await EmployeePurchase.updateMany(
      { _id: { $in: previous.map((r) => r.employeePurchaseId) } },
      { $set: { payrollDeductionId: null, payrollPeriod: "" } }
    );
    await EmployeePurchaseDeduction.deleteMany({
      _id: { $in: previous.map((r) => r._id) },
      status: "pending",
    });
  }

  const entryByUser = new Map(input.entries.map((e) => [e.userId, e.entryId]));
  const rows: Array<{
    employeePurchaseId: string;
    employeeId: string;
    branchId: string;
    payrollId: string;
    payrollEntryId: string;
    period: string;
    amount: number;
    status: "pending";
    idempotencyKey: string;
  }> = [];
  for (const [employeeId, row] of input.plan) {
    const entryId = entryByUser.get(employeeId);
    if (!entryId) continue;
    for (const purchase of row.purchases) {
      rows.push({
        employeePurchaseId: purchase.id,
        employeeId,
        branchId: input.branchId,
        payrollId: input.payrollId,
        payrollEntryId: entryId,
        period: input.period,
        amount: purchase.amount,
        status: "pending",
        idempotencyKey: `purchase:${purchase.id}:deduction:${input.period}`,
      });
      await EmployeePurchase.updateOne(
        { _id: purchase.id },
        { $set: { payrollDeductionId: null, payrollPeriod: input.period } }
      );
    }
  }
  if (rows.length > 0) {
    // A purchase already deducted in another (finalized) period has a unique
    // row; skip it instead of failing the whole payroll run.
    for (const row of rows) {
      try {
        const doc = await EmployeePurchaseDeduction.create(row);
        await EmployeePurchase.updateOne(
          { _id: row.employeePurchaseId },
          { $set: { payrollDeductionId: doc._id } }
        );
      } catch (err) {
        if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) continue;
        throw err;
      }
    }
  }
}

/**
 * Marks the payroll's pending deductions as applied and reduces the employee
 * balances. Idempotent: only `pending` rows of this payroll are processed, so
 * finalizing twice (or a retried request) cannot deduct twice.
 */
export async function applyPayrollPurchaseDeductions(input: {
  payrollId: string;
  period: string;
  branchId: string;
  userId: string;
}): Promise<{ applied: number; total: number }> {
  const rows = await EmployeePurchaseDeduction.find({
    payrollId: input.payrollId,
    status: "pending",
  }).lean();
  let applied = 0;
  let total = 0;

  for (const row of rows) {
    const result = await EmployeePurchaseDeduction.findOneAndUpdate(
      { _id: row._id, status: "pending" },
      {
        $set: {
          status: "applied",
          approvedBy: input.userId,
          approvedAt: new Date(),
        },
      },
      { new: true }
    );
    if (!result) continue; // another request won the race — never deduct twice

    const purchase = await EmployeePurchase.findById(row.employeePurchaseId);
    if (purchase) {
      purchase.outstandingAmount = round2(Math.max(0, purchase.outstandingAmount - row.amount));
      purchase.status = purchase.outstandingAmount <= 0 ? "deducted" : "open";
      purchase.payrollPeriod = input.period;
      await purchase.save();
    }

    await appendEmployeeLedger({
      employeeId: row.employeeId.toString(),
      branchId: row.branchId.toString(),
      employeePurchaseId: row.employeePurchaseId.toString(),
      type: "DEDUCTION",
      amount: row.amount,
      balanceDelta: -row.amount,
      referenceType: "payroll",
      referenceId: input.payrollId,
      description: `Salary deduction ${input.period} for employee purchase`,
      idempotencyKey: `deduction:${row._id.toString()}`,
      userId: input.userId,
      approvedBy: input.userId,
    });

    applied += 1;
    total = round2(total + row.amount);
  }

  return { applied, total };
}
