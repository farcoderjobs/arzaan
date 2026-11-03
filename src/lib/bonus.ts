import mongoose from "mongoose";
import { Customer, CustomerBonusTransaction } from "@/models";
import { round2 } from "@/lib/commerce";

/**
 * Customer reward-credit ("bonus") ledger.
 *
 * Bonus is NOT money and is kept completely separate from:
 *  - CustomerTransaction (credit debt),
 *  - Payment / CashTransaction (cash and revenue),
 *  - Sale.total (merchandise value).
 *
 * `Customer.bonusBalance` is the persistent running balance. Every mutation
 * goes through `appendBonusEntry`, which atomically increments the balance and
 * writes a signed ledger row carrying a unique idempotency key. Retries,
 * offline synchronization and duplicate refund submissions therefore cannot
 * credit the same event twice.
 */

export type BonusEntryInput = {
  customerId: string;
  branchId: string | null;
  type: "EARN" | "REDEEM" | "REVERSAL" | "RESTORE" | "EXPIRE" | "ADJUSTMENT";
  /** Signed delta: + earned/restored, − redeemed/reversed/expired. */
  amount: number;
  referenceType: "sale" | "sale_return" | "adjustment" | null;
  referenceId: string | null;
  description: string;
  /** EARN rows only: when the acquired credit stops being spendable. */
  expiresAt?: Date | null;
  /** Manager who approved a manual adjustment (required by the API). */
  approvedBy?: string | null;
  reason?: string;
  userId: string;
  idempotencyKey: string;
};

export async function appendBonusEntry(
  input: BonusEntryInput,
  session?: mongoose.ClientSession | null
): Promise<{ id: string; balanceAfter: number; amount: number; duplicate: boolean }> {
  const existing = await CustomerBonusTransaction.findOne({ idempotencyKey: input.idempotencyKey })
    .session(session ?? null)
    .lean();
  if (existing) {
    return {
      id: existing._id.toString(),
      balanceAfter: existing.balanceAfter,
      amount: existing.amount,
      duplicate: true,
    };
  }

  const amount = round2(input.amount);
  if (amount === 0) {
    throw new Error("Bonus amount cannot be zero");
  }

  const customer = await Customer.findOneAndUpdate(
    { _id: input.customerId },
    { $inc: { bonusBalance: amount } },
    { new: true, session: session ?? undefined }
  ).lean();

  if (!customer) throw new Error("Customer not found");

  let docs: Array<{ _id: mongoose.Types.ObjectId }>;
  try {
    docs = await CustomerBonusTransaction.create(
      [
        {
          customerId: input.customerId,
          branchId: input.branchId,
          type: input.type,
          amount,
          balanceAfter: round2(customer.bonusBalance),
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          description: input.description,
          expiresAt: input.expiresAt ?? null,
          approvedBy: input.approvedBy ?? null,
          reason: input.reason ?? "",
          idempotencyKey: input.idempotencyKey,
          userId: input.userId,
        },
      ],
      session ? { session } : undefined
    );
  } catch (err) {
    // A concurrent request won the idempotency race after we had already moved
    // the balance: undo our increment, then return the winner's result.
    if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) {
      await Customer.updateOne(
        { _id: input.customerId },
        { $inc: { bonusBalance: -amount } },
        session ? { session } : undefined
      );
      const winner = await CustomerBonusTransaction.findOne({ idempotencyKey: input.idempotencyKey })
        .session(session ?? null)
        .lean();
      return {
        id: winner?._id.toString() ?? "",
        balanceAfter: winner?.balanceAfter ?? 0,
        amount: winner?.amount ?? amount,
        duplicate: true,
      };
    }
    throw err;
  }

  return {
    id: docs[0]._id.toString(),
    balanceAfter: round2(customer.bonusBalance),
    amount,
    duplicate: false,
  };
}

/**
 * Writes off earned credit whose expiry date has passed. Each earning row is
 * expired at most once (its own idempotency key), and never more than the
 * customer's current balance, so the ledger can never go negative from this.
 */
export async function expireCustomerBonus(customerId: string, userId: string): Promise<number> {
  const customer = await Customer.findById(customerId).select("bonusBalance branchId").lean();
  if (!customer) return 0;
  let balance = round2(customer.bonusBalance ?? 0);
  if (balance <= 0) return 0;

  const earned = await CustomerBonusTransaction.find({
    customerId: new mongoose.Types.ObjectId(customerId),
    type: "EARN",
    expiresAt: { $ne: null, $lte: new Date() },
  })
    .sort({ createdAt: 1 })
    .lean();

  let expired = 0;
  for (const row of earned) {
    if (balance <= 0) break;
    const amount = round2(Math.min(balance, Math.abs(row.amount)));
    if (amount <= 0) continue;
    const result = await appendBonusEntry({
      customerId,
      branchId: customer.branchId ? customer.branchId.toString() : null,
      type: "EXPIRE",
      amount: -amount,
      referenceType: "adjustment",
      referenceId: row._id.toString(),
      description: `Expired bonus from ${row.description}`,
      userId,
      idempotencyKey: `expire:${row._id.toString()}`,
    });
    if (!result.duplicate) {
      balance = round2(balance - amount);
      expired = round2(expired + amount);
    }
  }
  return expired;
}

/** Current available reward credit (persistent balance, clamped for display). */
export async function getCustomerBonusBalance(customerId: string): Promise<number> {
  const customer = await Customer.findById(customerId).select("bonusBalance").lean();
  return round2(Math.max(0, customer?.bonusBalance ?? 0));
}

/** Raw balance, which may be negative after a return claws back spent credit. */
export async function getCustomerBonusBalanceRaw(customerId: string): Promise<number> {
  const customer = await Customer.findById(customerId).select("bonusBalance").lean();
  return round2(customer?.bonusBalance ?? 0);
}

export async function getCustomerBonusLedger(
  customerId: string,
  options: { page?: number; perPage?: number } = {}
) {
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(200, Math.max(1, options.perPage ?? 20));
  const query = { customerId: new mongoose.Types.ObjectId(customerId) };

  const [total, docs, summaryRows] = await Promise.all([
    CustomerBonusTransaction.countDocuments(query),
    CustomerBonusTransaction.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .populate<{ userId: { _id: mongoose.Types.ObjectId; name: string } | null }>("userId", "name")
      .lean(),
    CustomerBonusTransaction.aggregate<{ _id: string; total: number }>([
      { $match: query },
      { $group: { _id: "$type", total: { $sum: "$amount" } } },
    ]),
  ]);

  const summary = { earned: 0, redeemed: 0, reversed: 0, restored: 0, expired: 0, adjusted: 0 };
  for (const row of summaryRows) {
    if (row._id === "EARN") summary.earned = round2(row.total);
    else if (row._id === "REDEEM") summary.redeemed = round2(Math.abs(row.total));
    else if (row._id === "REVERSAL") summary.reversed = round2(Math.abs(row.total));
    else if (row._id === "RESTORE") summary.restored = round2(row.total);
    else if (row._id === "EXPIRE") summary.expired = round2(Math.abs(row.total));
    else if (row._id === "ADJUSTMENT") summary.adjusted = round2(row.total);
  }

  return {
    entries: docs.map((d) => ({
      _id: d._id.toString(),
      type: d.type,
      amount: d.amount,
      balanceAfter: d.balanceAfter,
      description: d.description,
      referenceType: d.referenceType ?? null,
      referenceId: d.referenceId ? d.referenceId.toString() : null,
      userId: d.userId
        ? {
            _id: (d.userId as unknown as { _id: mongoose.Types.ObjectId })._id.toString(),
            name: (d.userId as unknown as { name: string }).name,
          }
        : null,
      expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
      reason: d.reason ?? "",
      createdAt: d.createdAt.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
    summary,
  };
}
