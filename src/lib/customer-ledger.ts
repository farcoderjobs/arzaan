import mongoose from "mongoose";
import { CustomerTransaction } from "@/models";

/**
 * Customer ledger. The customer's outstanding balance is ALWAYS derived
 * from their transactions — never stored as an editable field.
 *
 * Sign convention:
 *  - SALE       (+): customer bought on credit      → owes more
 *  - PAYMENT    (−): customer paid us                → owes less
 *  - REFUND     (−): we refunded a credit sale       → owes less
 *  - ADJUSTMENT (±): manual correction (audited)     → signed
 */

export type LedgerEntry = {
  _id: string;
  type: "SALE" | "PAYMENT" | "REFUND" | "ADJUSTMENT";
  amount: number;
  balanceAfter: number;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  userId: { _id: string; name: string } | null;
  createdAt: string;
};

export async function getCustomerBalance(customerId: string): Promise<number> {
  const result = await CustomerTransaction.aggregate<{
    _id: null;
    balance: number;
  }>([
    { $match: { customerId: new mongoose.Types.ObjectId(customerId) } },
    { $group: { _id: null, balance: { $sum: "$amount" } } },
  ]);
  return Math.round((result[0]?.balance ?? 0) * 100) / 100;
}

/**
 * Appends a ledger entry computing balanceAfter from the running balance.
 * Must be called inside the same transaction/session as the caller when
 * atomicity matters (pass session).
 */
export async function appendLedgerEntry(
  input: {
    customerId: string;
    branchId: string | null;
    type: "SALE" | "PAYMENT" | "REFUND" | "ADJUSTMENT";
    /** Signed delta: positive increases what the customer owes. */
    amount: number;
    referenceType: "sale" | "sale_return" | "payment" | "adjustment" | null;
    referenceId: string | null;
    description: string;
    userId: string;
  },
  session?: mongoose.ClientSession | null
): Promise<{ id: string; balanceAfter: number }> {
  const running = await getCustomerBalance(input.customerId);
  const balanceAfter = Math.round((running + input.amount) * 100) / 100;

  const doc = await CustomerTransaction.create(
    [
      {
        customerId: input.customerId,
        branchId: input.branchId,
        type: input.type,
        amount: input.amount,
        balanceAfter,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        description: input.description,
        userId: input.userId,
      },
    ],
    session ? { session } : undefined
  );

  return { id: doc[0]._id.toString(), balanceAfter };
}

export async function getCustomerLedger(
  customerId: string,
  options: { page?: number; perPage?: number; type?: string } = {}
): Promise<{ entries: LedgerEntry[]; total: number; page: number; perPage: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(200, Math.max(1, options.perPage ?? 25));

  const query: Record<string, unknown> = { customerId: new mongoose.Types.ObjectId(customerId) };
  if (options.type) query.type = options.type;

  const total = await CustomerTransaction.countDocuments(query);
  const docs = await CustomerTransaction.find(query)
    .populate<{ userId: { _id: mongoose.Types.ObjectId; name: string } | null }>("userId", "name")
    .sort({ createdAt: -1 })
    .skip((page - 1) * perPage)
    .limit(perPage)
    .lean();

  return {
    entries: docs.map((d) => ({
      _id: d._id.toString(),
      type: d.type,
      amount: d.amount,
      balanceAfter: d.balanceAfter,
      description: d.description,
      referenceType: d.referenceType ?? null,
      referenceId: d.referenceId ? d.referenceId.toString() : null,
      userId: (d.userId as { _id: mongoose.Types.ObjectId; name: string } | null)
        ? { _id: (d.userId as { _id: mongoose.Types.ObjectId })._id.toString(), name: (d.userId as { name: string }).name }
        : null,
      createdAt: d.createdAt.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
