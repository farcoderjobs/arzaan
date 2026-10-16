import mongoose from "mongoose";
import { CashRegister, CashTransaction, Sale } from "@/models";
import { round2 } from "@/lib/commerce";
import { connectDB } from "@/lib/mongodb";

/**
 * Cash register sessions.
 *
 * Expected cash = opening + cash sales + cash income − cash refunds − cash expenses
 * (plus/minus adjustments). Every drawer movement is persisted as a CashTransaction
 * with a signed amount; the closing "closing" row stores the counted cash and is
 * excluded from the expected-cash aggregation.
 */

export class CashRegisterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Settings key that allows more than one open register per cashier. */
export const MULTI_REGISTER_KEY = "cash_register.allow_multiple_open";

export const CASH_IN_TYPES = ["opening", "sale", "income"] as const;
export const CASH_OUT_TYPES = ["refund", "expense"] as const;

type CashTxType =
  | "opening"
  | "sale"
  | "refund"
  | "expense"
  | "income"
  | "adjustment"
  | "closing"
  | "purchase"
  | "payment_in"
  | "payment_out";

export type AddCashTxInput = {
  registerId: string;
  userId: string;
  type: CashTxType;
  amount: number;
  description: string;
  referenceType?: "sale" | "sale_return" | "expense" | "customer_payment" | "supplier_payment" | "income" | "adjustment" | null;
  referenceId?: string | null;
  branchId?: string | null;
};

/** Records a single cash drawer movement (must be called with a session when atomic). */
export async function addCashTransaction(input: AddCashTxInput, session?: mongoose.ClientSession | null) {
  const doc = await CashTransaction.create(
    [
      {
        registerId: new mongoose.Types.ObjectId(input.registerId),
        userId: new mongoose.Types.ObjectId(input.userId),
        branchId: input.branchId ? new mongoose.Types.ObjectId(input.branchId) : null,
        type: input.type,
        amount: round2(input.amount),
        description: (input.description ?? "").slice(0, 500),
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ? new mongoose.Types.ObjectId(input.referenceId) : null,
      },
    ],
    session ? { session } : undefined
  );
  return doc[0];
}

/** Opens a register session for the cashier. Enforces one open register per cashier unless the store setting allows multiple. */
export async function openRegister(input: {
  userId: string;
  branchId: string | null;
  openCash: number;
  note?: string;
}) {
  await connectDB();

  const allowMultiple = await isMultipleRegistersEnabled(input.branchId);

  if (!allowMultiple) {
    const existing = await CashRegister.findOne({ openedBy: new mongoose.Types.ObjectId(input.userId), status: "open" });
    if (existing) {
      throw new CashRegisterError(
        "REGISTER_ALREADY_OPEN",
        "You already have an open register. Close it before opening a new one."
      );
    }
  }

  const now = new Date();
  const register = await CashRegister.create({
    branchId: input.branchId ? new mongoose.Types.ObjectId(input.branchId) : null,
    status: "open",
    openCash: round2(input.openCash),
    expectedCash: round2(input.openCash),
    countedCash: null,
    difference: null,
    openedAt: now,
    closedAt: null,
    openedBy: new mongoose.Types.ObjectId(input.userId),
    closedBy: null,
    note: (input.note ?? "").slice(0, 500),
  });

  await addCashTransaction({
    registerId: register._id.toString(),
    userId: input.userId,
    type: "opening",
    amount: round2(input.openCash),
    description: "Opening cash",
    branchId: input.branchId,
  });

  return register;
}

export async function isMultipleRegistersEnabled(branchId: string | null): Promise<boolean> {
  if (!branchId) return false;
  const settings = await mongoose
    .model("StoreSettings")
    .findOne({ branchId: new mongoose.Types.ObjectId(branchId), key: MULTI_REGISTER_KEY })
    .lean<{ value: unknown } | null>();
  return settings?.value === true;
}

export async function getOpenRegisterForUser(userId: string) {
  return CashRegister.findOne({ openedBy: new mongoose.Types.ObjectId(userId), status: "open" })
    .sort({ openedAt: -1 })
    .lean();
}

/**
 * Aggregates the drawer summary for a register (expected cash math).
 * Runs as one MongoDB aggregation pipeline over cash transactions.
 */
export async function getRegisterSummary(registerId: string) {
  const objectId = new mongoose.Types.ObjectId(registerId);
  const results = await CashTransaction.aggregate<{
    opening: number;
    sales: number;
    refunds: number;
    expenses: number;
    income: number;
    adjustments: number;
    counted: number | null;
  }>([
    { $match: { registerId: objectId } },
    {
      $group: {
        _id: null,
        opening: { $sum: { $cond: [{ $eq: ["$type", "opening"] }, "$amount", 0] } },
        sales: { $sum: { $cond: [{ $eq: ["$type", "sale"] }, "$amount", 0] } },
        refunds: { $sum: { $cond: [{ $eq: ["$type", "refund"] }, "$amount", 0] } },
        expenses: { $sum: { $cond: [{ $eq: ["$type", "expense"] }, "$amount", 0] } },
        income: { $sum: { $cond: [{ $eq: ["$type", "income"] }, "$amount", 0] } },
        adjustments: { $sum: { $cond: [{ $eq: ["$type", "adjustment"] }, "$amount", 0] } },
        closing: { $sum: { $cond: [{ $eq: ["$type", "closing"] }, "$amount", 0] } },
      },
    },
    {
      $project: {
        _id: 0,
        opening: 1,
        sales: 1,
        refunds: 1,
        expenses: 1,
        income: 1,
        adjustments: 1,
        counted: {
          $cond: [{ $gt: ["$closing", 0] }, "$closing", null],
        },
      },
    },
  ]);

  const r = results[0] ?? { opening: 0, sales: 0, refunds: 0, expenses: 0, income: 0, adjustments: 0, counted: null };
  // Refunds and expenses are stored as signed (negative) amounts, so the expected
  // cash is simply the sum of every movement in the session.
  const expected = round2(r.opening + r.sales + r.income + r.refunds + r.expenses + r.adjustments);
  return {
    openingCash: round2(r.opening),
    cashSales: round2(r.sales),
    cashRefunds: round2(r.refunds),
    cashExpenses: round2(r.expenses),
    cashIncome: round2(r.income),
    adjustments: round2(r.adjustments),
    expectedCash: expected,
    countedCash: r.counted !== null && r.counted !== undefined ? round2(r.counted) : null,
    difference: r.counted !== null && r.counted !== undefined ? round2(r.counted - expected) : null,
  };
}

/** Closes a register: records the counted cash, computes the difference, and locks the session. */
export async function closeRegister(input: {
  registerId: string;
  userId: string;
  countedCash: number;
  note?: string;
}) {
  await connectDB();
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const register = await CashRegister.findOne({ _id: input.registerId, status: "open" }).session(session);
      if (!register) {
        throw new CashRegisterError("REGISTER_NOT_OPEN", "Register not found or already closed");
      }

      const summary = await getRegisterSummary(input.registerId);

      register.status = "closed";
      register.countedCash = round2(input.countedCash);
      register.difference = summary.difference ?? round2(input.countedCash - summary.expectedCash);
      register.expectedCash = summary.expectedCash;
      register.closedBy = new mongoose.Types.ObjectId(input.userId);
      register.closedAt = new Date();
      register.note = ((register.note ?? "") + (input.note ? `${register.note ? " | " : ""}${input.note}` : "")).slice(0, 500);
      await register.save({ session });

      // Persist the counted amount as the closing row (excluded from expected-cash aggregation)
      await addCashTransaction(
        {
          registerId: input.registerId,
          userId: input.userId,
          type: "closing",
          amount: round2(input.countedCash),
          description: "Closing counted cash",
          branchId: register.branchId ? register.branchId.toString() : null,
        },
        session
      );

      return { registerId: input.registerId, ...summary, countedCash: round2(input.countedCash) };
    });
  } finally {
    await session.endSession();
  }

  const register = await CashRegister.findById(input.registerId).lean();
  const summary = await getRegisterSummary(input.registerId);
  return {
    register: register
      ? {
          id: register._id.toString(),
          status: register.status,
          openedAt: register.openedAt,
          closedAt: register.closedAt,
        }
      : null,
    ...summary,
  };
}

/** Lists cash transactions for a register with pagination. */
export async function listCashTransactions(
  registerId: string,
  options: { page?: number; perPage?: number; type?: string } = {}
) {
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(200, Math.max(1, options.perPage ?? 25));
  const query: Record<string, unknown> = { registerId: new mongoose.Types.ObjectId(registerId) };
  if (options.type) query.type = options.type;

  const [total, docs] = await Promise.all([
    CashTransaction.countDocuments(query),
    CashTransaction.find(query)
      .populate<{ userId: { _id: mongoose.Types.ObjectId; name: string } | null }>("userId", "name")
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
  ]);

  return {
    transactions: docs.map((d) => ({
      _id: d._id.toString(),
      type: d.type,
      amount: d.amount,
      description: d.description,
      userName: (d.userId as unknown as { name: string } | null)?.name ?? "—",
      referenceType: d.referenceType ?? null,
      createdAt: d.createdAt.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

/** Cash sales for the register session (from linked sales). */
export async function listRegisterSales(registerId: string, options: { page?: number; perPage?: number } = {}) {
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(100, Math.max(1, options.perPage ?? 10));

  const query = { registerId: new mongoose.Types.ObjectId(registerId), status: "completed" as const };
  const [total, sales] = await Promise.all([
    Sale.countDocuments(query),
    Sale.find(query)
      .select("invoiceNumber total paidAmount changeAmount paymentMethod createdAt customerId")
      .populate<{ customerId: { name: string } | null }>("customerId", "name")
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
  ]);

  return {
    sales: sales.map((s) => ({
      _id: s._id.toString(),
      invoiceNumber: s.invoiceNumber,
      total: s.total,
      paidAmount: s.paidAmount,
      changeAmount: s.changeAmount,
      paymentMethod: s.paymentMethod,
      customerName: (s.customerId as unknown as { name: string } | null)?.name ?? null,
      createdAt: s.createdAt.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
