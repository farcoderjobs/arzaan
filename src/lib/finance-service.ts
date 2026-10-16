import mongoose from "mongoose";
import { CashRegister, Payment, Expense } from "@/models";
import { round2 } from "@/lib/commerce";
import { addCashTransaction, CashRegisterError } from "@/lib/cash-register";

/**
 * Finance service helpers.
 *
 * Cash integration rule: any financial transaction paid in CASH is pushed into
 * the acting user's open register as a signed CashTransaction, so the drawer's
 * expected cash stays truthful. Non-cash methods never touch the drawer.
 */

export class FinanceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Finds the user's open register; throws when a CASH transaction has no drawer to draw from. */
export async function requireOpenRegister(userId: string, session?: mongoose.ClientSession | null) {
  const register = await CashRegister.findOne({
    openedBy: new mongoose.Types.ObjectId(userId),
    status: "open",
  })
    .sort({ openedAt: -1 })
    .session(session ?? null);

  if (!register) {
    throw new CashRegisterError("NO_OPEN_REGISTER", "No open cash register. Open your register first to handle cash payments.");
  }
  return register;
}

export type CashMovementInput = {
  userId: string;
  branchId: string | null;
  type: "sale" | "refund" | "expense" | "income" | "adjustment";
  amount: number;
  description: string;
  referenceType: "sale" | "sale_return" | "expense" | "customer_payment" | "supplier_payment" | "income" | "adjustment";
  referenceId: string;
};

/** Records a cash movement in the user's open register (no-op when amount is zero). */
export async function recordCashMovement(input: CashMovementInput, session?: mongoose.ClientSession | null) {
  const amount = round2(input.amount);
  if (amount === 0) return;
  const register = await requireOpenRegister(input.userId, session);
  await addCashTransaction(
    {
      registerId: register._id.toString(),
      userId: input.userId,
      type: input.type,
      amount,
      description: input.description,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      branchId: input.branchId,
    },
    session
  );
}

/** Persists an audit Payment row for money that moved (skips zero amounts). */
export async function recordPaymentDoc(input: {
  type: "sale" | "purchase" | "account_receivable" | "account_payable" | "expense" | "other";
  referenceType: "sale" | "purchase" | "customer_transaction" | "supplier_transaction" | "expense" | "cash_register" | null;
  referenceId: string | null;
  amount: number;
  method: "cash" | "card" | "transfer" | "check" | "account" | "other";
  description: string;
  userId: string;
  branchId: string | null;
}) {
  if (round2(input.amount) <= 0) return null;
  const doc = await Payment.create(
    [
      {
        type: input.type,
        referenceType: input.referenceType,
        referenceId: input.referenceId ? new mongoose.Types.ObjectId(input.referenceId) : null,
        amount: round2(input.amount),
        method: input.method,
        description: (input.description ?? "").slice(0, 500),
        userId: new mongoose.Types.ObjectId(input.userId),
        branchId: input.branchId ? new mongoose.Types.ObjectId(input.branchId) : null,
      },
    ]
  );
  return doc[0];
}

/**
 * Best-effort cash movement: records into the open register when one exists and
 * quietly skips otherwise (used for refunds made with no drawer open — the
 * return itself must not fail, and the omission is written to the audit log).
 */
export async function recordCashMovementIfDrawerOpen(input: CashMovementInput, session?: mongoose.ClientSession | null) {
  const amount = round2(input.amount);
  if (amount === 0) return;
  const register = await CashRegister.findOne({
    openedBy: new mongoose.Types.ObjectId(input.userId),
    status: "open",
  })
    .sort({ openedAt: -1 })
    .session(session ?? null);
  if (!register) {
    await mongoose.model("AuditLog").create([
      {
        action: "cash_movement_without_register",
        entityType: "CashTransaction",
        entityId: input.referenceId ? new mongoose.Types.ObjectId(input.referenceId) : null,
        userId: new mongoose.Types.ObjectId(input.userId),
        branchId: input.branchId ? new mongoose.Types.ObjectId(input.branchId) : null,
        changes: {},
        note: `${input.type} ${amount} — ${input.description} (no open register)`,
      },
    ]);
    return;
  }
  await addCashTransaction(
    {
      registerId: register._id.toString(),
      userId: input.userId,
      type: input.type,
      amount,
      description: input.description,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      branchId: input.branchId,
    },
    session
  );
}

/** Supplier outstanding balance from the signed ledger (aggregation, not stored). */
export async function getSupplierBalance(supplierId: string): Promise<number> {
  const result = await mongoose
    .model("SupplierTransaction")
    .aggregate<{ balance: number }>([
      { $match: { supplierId: new mongoose.Types.ObjectId(supplierId) } },
      { $group: { _id: null, balance: { $sum: "$amount" } } },
    ]);
  return round2(result[0]?.balance ?? 0);
}

/** Builds a safe regex escape for user search input. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { Expense };
