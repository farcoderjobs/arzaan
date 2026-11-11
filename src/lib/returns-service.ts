import mongoose from "mongoose";
import { Sale, SaleReturn, InventoryMovement, ISaleItemSnapshot, ISaleReturnItemSnapshot } from "@/models";
import { computeBonusReversal, round2 } from "@/lib/commerce";
import { appendLedgerEntry } from "@/lib/customer-ledger";
import { appendBonusEntry } from "@/lib/bonus";
import { getStoreSettings } from "@/lib/settings";
import { applyEmployeePurchaseReturn } from "@/lib/employee-purchase";
import { recordCashMovementIfDrawerOpen } from "@/lib/finance-service";
import { connectDB } from "@/lib/mongodb";

/**
 * Sale return service.
 *
 * Rules enforced here:
 *  - Cannot return more than originally sold (accounting for previous approved
 *    and pending returns, per original sale line).
 *  - Original sale is never modified or deleted.
 *  - Only inventory lines marked `restock` re-enter stock; direct-sale lines
 *    never touch the inventory ledger.
 *  - Refunds are priced from the original sale snapshot (including wholesale
 *    prices, discounts and tax actually charged).
 *  - Reward credit earned by the sale is reversed proportionally.
 *  - Duplicate processing is prevented by a unique clientTransactionId plus
 *    quantity re-validation inside the transaction.
 *  - Manager approval is required when the settings flag `returns.requireApproval` is on.
 */

export type ReturnItemInput = {
  /** Original sale line id — required to distinguish duplicate product lines. */
  lineId?: string;
  /** Backwards-compatible identifier for inventory lines. */
  productId?: string;
  quantity: number;
  /** Inventory lines only; default true. Direct lines are never restocked. */
  restock?: boolean;
};

export type CreateReturnInput = {
  saleId: string;
  userId: string;
  items: ReturnItemInput[];
  refundMethod: "cash" | "original" | "credit" | "card" | "transfer";
  reason: string;
  note?: string;
  requireApproval?: boolean;
  /** Idempotency key for POS submissions. */
  clientTransactionId?: string | null;
};

export class ReturnValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type SaleWithLines = {
  _id: mongoose.Types.ObjectId;
  invoiceNumber: string;
  branchId: mongoose.Types.ObjectId | null;
  customerId: mongoose.Types.ObjectId | null;
  paymentMethod: string | null;
  payments: Array<{ method: string; amount: number }>;
  items: Array<ISaleItemSnapshot & { _id?: mongoose.Types.ObjectId }>;
  subtotal: number;
  /** Includes line discounts plus sale-level discount and employee benefit. */
  discount: number;
  total: number;
  bonusEarned: number;
  bonusRedeemed?: number;
};

function lineIdOf(line: ISaleItemSnapshot & { _id?: mongoose.Types.ObjectId }): string {
  return line._id ? line._id.toString() : `${line.productId ?? "direct"}:${line.sku}:${line.name}`;
}

export type RefundableLine = { subtotal: number; tax: number; discount: number; quantity: number };
export type RefundableSale = { subtotal: number; discount: number; items: RefundableLine[] };

/**
 * What the customer actually paid for one sale line (all of its quantity).
 *
 * A line snapshot's `subtotal` already nets that line's own discount, but a
 * sale-level discount and the employer-funded employee benefit only exist on
 * the sale. Refunding the raw subtotal would hand back more than was paid, so
 * the extra discount is prorated over each line's net (pre-tax) value — which
 * keeps the deduction attached to that specific product.
 */
export function lineRefundValue(
  sale: RefundableSale,
  line: RefundableLine
): { paid: number; discountApplied: number } {
  const lineDiscountTotal = round2(
    (sale.items ?? []).reduce((sum, item) => sum + (item.discount ?? 0), 0)
  );
  const extraDiscount = round2(Math.max(0, (sale.discount ?? 0) - lineDiscountTotal));
  const netBase = round2((sale.subtotal ?? 0) - lineDiscountTotal);
  const lineNet = round2((line.subtotal ?? 0) - (line.tax ?? 0));
  const share = netBase > 0 ? Math.max(0, Math.min(1, lineNet / netBase)) : 0;
  const discountApplied = round2(Math.min(line.subtotal ?? 0, extraDiscount * share));
  return { paid: round2((line.subtotal ?? 0) - discountApplied), discountApplied };
}

/** Refund owed for `quantity` returned units of one sale line. */
export function refundForQuantity(sale: RefundableSale, line: RefundableLine, quantity: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0 || line.quantity <= 0) return 0;
  const { paid } = lineRefundValue(sale, line);
  if (quantity >= line.quantity) return paid;
  return round2((paid * quantity) / line.quantity);
}

/**
 * Previously returned quantities, keyed by original sale line id. Legacy return
 * rows without `sourceLineId` fall back to the first matching product line.
 */
export async function getReturnedQuantities(
  saleId: string,
  session?: mongoose.ClientSession | null,
  excludeReturnId?: string | null
): Promise<Map<string, number>> {
  const query: Record<string, unknown> = {
    saleId: new mongoose.Types.ObjectId(saleId),
    status: { $in: ["pending", "approved"] },
  };
  if (excludeReturnId && mongoose.isValidObjectId(excludeReturnId)) {
    query._id = { $ne: new mongoose.Types.ObjectId(excludeReturnId) };
  }

  const returns = await SaleReturn.find(query)
    .select("items")
    .session(session ?? null)
    .lean();

  const map = new Map<string, number>();
  for (const saleReturn of returns) {
    for (const item of saleReturn.items) {
      const key = item.sourceLineId || (item.productId ? `product:${item.productId.toString()}` : "");
      if (!key) continue;
      map.set(key, round2((map.get(key) ?? 0) + item.quantity));
    }
  }
  return map;
}

/**
 * Validates requested returns against the original sale lines and returns
 * immutable snapshots priced exactly as the customer originally paid.
 */
export async function buildReturnItems(
  sale: SaleWithLines,
  requested: ReturnItemInput[],
  session: mongoose.ClientSession,
  excludeReturnId?: string | null
): Promise<{ items: ISaleReturnItemSnapshot[]; subtotal: number }> {
  if (!requested || requested.length === 0) {
    throw new ReturnValidationError("EMPTY_RETURN", "At least one item is required for a return");
  }

  const returnedMap = await getReturnedQuantities(sale._id.toString(), session, excludeReturnId);

  const lines = sale.items.map((line) => {
    const lineId = lineIdOf(line);
    const sold = line.quantity;
    const legacyKey = line.productId ? `product:${line.productId.toString()}` : "";
    const already = round2((returnedMap.get(lineId) ?? 0) + (legacyKey ? returnedMap.get(legacyKey) ?? 0 : 0));
    return { line, lineId, sold, already, remaining: round2(sold - already) };
  });

  const result: ISaleReturnItemSnapshot[] = [];

  for (const request of requested) {
    const target = request.lineId
      ? lines.find((l) => l.lineId === request.lineId)
      : request.productId
        ? lines.find((l) => l.line.productId?.toString() === request.productId && l.remaining > 0)
        : undefined;

    if (!target) {
      throw new ReturnValidationError("ITEM_NOT_ON_SALE", "Returned item was not part of the original sale");
    }
    if (!Number.isInteger(request.quantity) || request.quantity < 1) {
      throw new ReturnValidationError("INVALID_QUANTITY", "Return quantity must be a whole number of at least 1");
    }
    if (request.quantity > target.remaining + 0.001) {
      throw new ReturnValidationError(
        "EXCEEDS_SOLD_QUANTITY",
        `Cannot return ${request.quantity} of ${target.line.name}: only ${target.remaining} remaining returnable`
      );
    }

    const item = target.line;
    // Snapshot from the ORIGINAL sale — price the customer actually paid,
    // including wholesale pricing, line/sale discounts, tax and any employee
    // benefit. Refunding the raw subtotal would return more than was paid.
    const lineTotal = refundForQuantity(sale, item, request.quantity);
    const isInventory = (item.itemType ?? "inventory") === "inventory" && Boolean(item.productId);
    result.push({
      productId: item.productId ?? null,
      itemType: item.itemType ?? "inventory",
      sourceLineId: target.lineId,
      restock: isInventory && request.restock !== false,
      pricingMode: item.pricingMode ?? "retail",
      name: item.name,
      sku: item.sku,
      quantity: request.quantity,
      sellingPrice: item.sellingPrice,
      costPrice: item.costPrice,
      discount: round2(item.discount * (request.quantity / item.quantity)),
      tax: round2(item.tax * (request.quantity / item.quantity)),
      subtotal: lineTotal,
      // Keep the line's department so returns reduce the department that sold it.
      departmentId: item.departmentId ?? null,
      departmentName: item.departmentName ?? "",
    });
    target.remaining = round2(target.remaining - request.quantity);
  }

  const subtotal = round2(result.reduce((sum, i) => sum + i.subtotal, 0));
  return { items: result, subtotal };
}

/** Re-enters eligible inventory lines from a return. Never restocks direct lines. */
export async function restockReturnItems(
  saleReturn: {
    _id: mongoose.Types.ObjectId;
    returnNumber: string;
    branchId: mongoose.Types.ObjectId | null;
    items: Array<ISaleReturnItemSnapshot>;
  },
  saleInvoiceNumber: string,
  userId: string,
  session: mongoose.ClientSession
) {
  const movements = saleReturn.items
    .filter((item) => item.itemType !== "direct" && item.restock !== false && item.productId)
    .map((item) => ({
      productId: item.productId,
      branchId: saleReturn.branchId,
      movementType: "CUSTOMER_RETURN_IN" as const,
      quantity: item.quantity,
      unitCost: item.costPrice,
      referenceType: "return" as const,
      referenceId: saleReturn._id,
      note: `Return ${saleReturn.returnNumber} for ${saleInvoiceNumber}`,
      userId: new mongoose.Types.ObjectId(userId),
    }));
  if (movements.length > 0) {
    await InventoryMovement.insertMany(movements, { session });
  }
}

/**
 * Proportional reward-credit clawback. Only approved returns reverse credit;
 * pending returns do nothing until approval.
 */
export async function reverseBonusForReturn(
  sale: SaleWithLines,
  saleReturn: {
    _id: mongoose.Types.ObjectId;
    returnNumber: string;
    total: number;
    bonusReversed?: number;
  },
  userId: string,
  session: mongoose.ClientSession
): Promise<number> {
  if (!sale.customerId || !sale.bonusEarned || sale.bonusEarned <= 0) return 0;

  const prior = await SaleReturn.find({
    saleId: sale._id,
    status: "approved",
    _id: { $ne: saleReturn._id },
  })
    .select("bonusReversed")
    .session(session)
    .lean();
  const alreadyReversed = round2(prior.reduce((sum, r) => sum + (r.bonusReversed ?? 0), 0));

  const amount = computeBonusReversal({
    earned: sale.bonusEarned,
    refundAmount: saleReturn.total,
    saleTotal: sale.total,
    alreadyReversed,
  });
  if (amount <= 0) return 0;

  await appendBonusEntry(
    {
      customerId: sale.customerId.toString(),
      branchId: sale.branchId ? sale.branchId.toString() : null,
      type: "REVERSAL",
      amount: -amount,
      referenceType: "sale_return",
      referenceId: saleReturn._id.toString(),
      description: `Reward credit reversed on return ${saleReturn.returnNumber}`,
      userId,
      idempotencyKey: `return:${saleReturn._id.toString()}:reverse`,
    },
    session
  );
  return amount;
}

async function applyApprovedReturnSideEffects(
  sale: SaleWithLines,
  saleReturn: {
    _id: mongoose.Types.ObjectId;
    returnNumber: string;
    branchId: mongoose.Types.ObjectId | null;
    customerId: mongoose.Types.ObjectId | null;
    items: ISaleReturnItemSnapshot[];
    total: number;
    refundMethod: string;
    note?: string | null;
    bonusReversed?: number;
    bonusRestored?: number;
  },
  userId: string,
  session: mongoose.ClientSession
) {
  await restockReturnItems(
    {
      _id: saleReturn._id,
      returnNumber: saleReturn.returnNumber,
      branchId: saleReturn.branchId ?? sale.branchId,
      items: saleReturn.items,
    },
    sale.invoiceNumber,
    userId,
    session
  );

  // Financial transaction: refund settling a credit sale reduces customer debt.
  if (sale.customerId) {
    const isCreditSettlement = saleReturn.refundMethod === "credit" || sale.paymentMethod === "credit" || hasCreditPayment(sale);
    if (isCreditSettlement) {
      await appendLedgerEntry(
        {
          customerId: sale.customerId.toString(),
          branchId: sale.branchId ? sale.branchId.toString() : null,
          type: "REFUND",
          amount: -saleReturn.total,
          referenceType: "sale_return",
          referenceId: saleReturn._id.toString(),
          description:
            saleReturn.refundMethod === "credit"
              ? `Refund (store credit) for ${sale.invoiceNumber} — ${saleReturn.returnNumber}`
              : `Refund for ${sale.invoiceNumber} — ${saleReturn.returnNumber}`,
          userId,
        },
        session
      );
    }
  }

  // Cash refunds physically leave the drawer.
  if (resolveRefundMethod(sale, saleReturn.refundMethod) === "cash") {
    await recordCashMovementIfDrawerOpen(
      {
        userId,
        branchId: sale.branchId ? sale.branchId.toString() : null,
        type: "refund",
        amount: -saleReturn.total,
        description: `Refund ${saleReturn.returnNumber} for ${sale.invoiceNumber}`,
        referenceType: "sale_return",
        referenceId: saleReturn._id.toString(),
      },
      session
    );
  }

  saleReturn.bonusReversed = await reverseBonusForReturn(sale, saleReturn, userId, session);
  saleReturn.bonusRestored = await restoreBonusForReturn(sale, saleReturn, userId, session);

  // Employee purchases are recovered from salary: a return reduces what the
  // employee still owes. Already-deducted amounts become a credit instead of
  // rewriting finalized payroll.
  const employeeAdjustment = await applyEmployeePurchaseReturn({
    saleId: sale._id.toString(),
    refundAmount: saleReturn.total,
    returnId: saleReturn._id.toString(),
    userId,
    approvedBy: userId,
  });
  if (employeeAdjustment) {
    saleReturn.note = [saleReturn.note, `Employee balance reduced by ${employeeAdjustment.adjusted}`]
      .filter(Boolean)
      .join(" · ");
  }
}

/**
 * Gives back reward credit the customer spent on the original sale, in the
 * same proportion as the refunded value, when the refund policy allows it.
 * Cumulative restoration can never exceed what was originally redeemed.
 */
async function restoreBonusForReturn(
  sale: SaleWithLines,
  saleReturn: { _id: mongoose.Types.ObjectId; returnNumber: string; total: number; bonusRestored?: number },
  userId: string,
  session: mongoose.ClientSession
): Promise<number> {
  const redeemed = round2(sale.bonusRedeemed ?? 0);
  if (!sale.customerId || redeemed <= 0 || sale.total <= 0) return 0;

  const settings = await getStoreSettings(sale.branchId ? sale.branchId.toString() : null);
  if (!settings.bonusRestoreRedeemedOnRefund) return 0;

  const prior = await SaleReturn.find({
    saleId: sale._id,
    status: "approved",
    _id: { $ne: saleReturn._id },
  })
    .select("bonusRestored")
    .session(session)
    .lean();
  const alreadyRestored = round2(prior.reduce((sum, r) => sum + (r.bonusRestored ?? 0), 0));

  const share = Math.min(1, Math.max(0, saleReturn.total / sale.total));
  const amount = round2(Math.min(redeemed - alreadyRestored, round2(redeemed * share)));
  if (amount <= 0) return 0;

  await appendBonusEntry(
    {
      customerId: sale.customerId.toString(),
      branchId: sale.branchId ? sale.branchId.toString() : null,
      type: "RESTORE",
      amount,
      referenceType: "sale_return",
      referenceId: saleReturn._id.toString(),
      description: `Reward credit restored on return ${saleReturn.returnNumber}`,
      userId,
      idempotencyKey: `return:${saleReturn._id.toString()}:restore`,
    },
    session
  );
  return amount;
}

function hasCreditPayment(sale: { payments: Array<{ method: string; amount: number }> }): boolean {
  return (sale.payments ?? []).some((p) => p.method === "credit" && p.amount > 0);
}

/** Resolves `original` to the tender the customer actually used. */
export function resolveRefundMethod(
  sale: { paymentMethod: string | null; payments: Array<{ method: string; amount: number }> },
  requested: string
): string {
  if (requested !== "original") return requested;
  if (sale.paymentMethod === "cash") return "cash";
  if (sale.paymentMethod === "credit") return "credit";
  if (sale.paymentMethod === "mixed") {
    return (sale.payments ?? []).some((p) => p.method === "cash") ? "cash" : "card";
  }
  return sale.paymentMethod ?? "cash";
}

function makeReturnNumber(): string {
  return `RET-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, "0")}-${Date.now().toString().slice(-8)}`;
}

export async function createSaleReturn(input: CreateReturnInput) {
  await connectDB();

  const session = await mongoose.startSession();
  let created: {
    id: string;
    returnNumber: string;
    total: number;
    status: string;
    refundAmount: number;
    bonusReversed: number;
  };

  try {
    await session.withTransaction(async () => {
      if (input.clientTransactionId) {
        const existing = await SaleReturn.findOne({ clientTransactionId: input.clientTransactionId }).session(session).lean();
        if (existing) {
          created = {
            id: existing._id.toString(),
            returnNumber: existing.returnNumber,
            total: existing.total,
            status: existing.status,
            refundAmount: existing.total,
            bonusReversed: existing.bonusReversed ?? 0,
          };
          return;
        }
      }

      const sale = await Sale.findOne({ _id: input.saleId, status: "completed" }).session(session);
      if (!sale) {
        throw new ReturnValidationError("SALE_NOT_FOUND", "Sale not found or not eligible for return");
      }

      const { items: returnItems, subtotal } = await buildReturnItems(sale as unknown as SaleWithLines, input.items, session);
      const refundAmount = subtotal;

      const requireApproval = input.requireApproval ?? false;
      const status: "pending" | "approved" = requireApproval ? "pending" : "approved";
      const returnNumber = makeReturnNumber();

      const returnDocs = await SaleReturn.create(
        [
          {
            returnNumber,
            clientTransactionId: input.clientTransactionId ?? null,
            saleId: sale._id,
            branchId: sale.branchId,
            customerId: sale.customerId,
            userId: input.userId,
            // Snapshot the original sale's attribution so refunds are reported
            // against the department that actually made the sale.
            employeeId: sale.employeeId ?? sale.cashierId,
            departmentId: sale.departmentId ?? null,
            departmentName: sale.departmentName ?? "",
            status,
            items: returnItems,
            subtotal,
            discount: 0,
            tax: 0,
            total: refundAmount,
            refundMethod: input.refundMethod,
            reason: input.reason.slice(0, 300),
            note: (input.note ?? "").slice(0, 300),
            replacementTotal: 0,
            netAmount: -refundAmount,
            bonusReversed: 0,
            approvedBy: status === "approved" ? input.userId : null,
            approvedAt: status === "approved" ? new Date() : null,
          },
        ],
        { session }
      );
      const saleReturn = returnDocs[0];

      if (status === "approved") {
        await applyApprovedReturnSideEffects(
          sale as unknown as SaleWithLines,
          saleReturn as unknown as Parameters<typeof applyApprovedReturnSideEffects>[1],
          input.userId,
          session
        );
        await saleReturn.save({ session });
      }

      created = {
        id: saleReturn._id.toString(),
        returnNumber,
        total: refundAmount,
        status,
        refundAmount,
        bonusReversed: saleReturn.bonusReversed ?? 0,
      };
    });
  } finally {
    await session.endSession();
  }

  return created!;
}

/**
 * Approves or rejects a pending return (manager action).
 * Side effects are applied at approval time.
 */
export async function approveSaleReturn(returnId: string, approverUserId: string) {
  await connectDB();
  const session = await mongoose.startSession();
  let result: { id: string; status: string; bonusReversed: number };

  try {
    await session.withTransaction(async () => {
      const saleReturn = await SaleReturn.findOne({ _id: returnId, status: "pending" }).session(session);
      if (!saleReturn) {
        throw new ReturnValidationError("RETURN_NOT_FOUND", "Pending return not found");
      }

      const sale = await Sale.findById(saleReturn.saleId).session(session);
      if (!sale) {
        throw new ReturnValidationError("SALE_NOT_FOUND", "Original sale not found");
      }

      // Re-validate returnable quantities at approval time using the stored
      // line references, excluding this pending return itself.
      await buildReturnItems(
        sale as unknown as SaleWithLines,
        saleReturn.items.map((item) => ({
          lineId: item.sourceLineId || undefined,
          productId: item.productId?.toString(),
          quantity: item.quantity,
          restock: item.restock,
        })),
        session,
        saleReturn._id.toString()
      );

      saleReturn.status = "approved";
      saleReturn.approvedBy = new mongoose.Types.ObjectId(approverUserId);
      saleReturn.approvedAt = new Date();
      await saleReturn.save({ session });

      await applyApprovedReturnSideEffects(
        sale as unknown as SaleWithLines,
        saleReturn as unknown as Parameters<typeof applyApprovedReturnSideEffects>[1],
        approverUserId,
        session
      );
      await saleReturn.save({ session });

      result = {
        id: saleReturn._id.toString(),
        status: "approved",
        bonusReversed: saleReturn.bonusReversed ?? 0,
      };
    });
  } finally {
    await session.endSession();
  }

  return result!;
}

export async function rejectSaleReturn(returnId: string, approverUserId: string) {
  await connectDB();
  const saleReturn = await SaleReturn.findOne({ _id: returnId, status: "pending" });
  if (!saleReturn) {
    throw new ReturnValidationError("RETURN_NOT_FOUND", "Pending return not found");
  }
  saleReturn.status = "rejected";
  saleReturn.rejectedAt = new Date();
  saleReturn.approvedBy = new mongoose.Types.ObjectId(approverUserId);
  await saleReturn.save();
  return { id: saleReturn._id.toString(), status: "rejected" };
}

export type { ISaleReturnItemSnapshot };
