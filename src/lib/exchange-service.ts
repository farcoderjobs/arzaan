import mongoose from "mongoose";
import { Sale, SaleReturn, InventoryMovement, ISaleItemSnapshot } from "@/models";
import { PaymentInput, round2, SalePricingMode } from "@/lib/commerce";
import { connectDB } from "@/lib/mongodb";
import { appendLedgerEntry } from "@/lib/customer-ledger";
import { recordCashMovementIfDrawerOpen } from "@/lib/finance-service";
import {
  buildReturnItems,
  restockReturnItems,
  reverseBonusForReturn,
  lineRefundValue,
  ReturnItemInput,
  ReturnValidationError,
  resolveRefundMethod,
  type RefundableSale,
} from "@/lib/returns-service";
import {
  CompleteSaleInput,
  prepareSale,
  persistPreparedSale,
} from "@/lib/sales-service";

/**
 * Refund / exchange inside POS.
 *
 * A single MongoDB transaction performs the return, the replacement sale (if
 * any), restocking, net settlement and reward-credit reversal. The original
 * sale is never modified. `clientTransactionId` makes retries idempotent, and
 * returnable quantities are re-validated inside the transaction.
 */

export type ExchangeReplacement = {
  items: Array<{ productId: string; quantity: number; unitDiscount: number }>;
  directItems?: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    unitCost: number;
    taxRate: number;
  }>;
  discount: number;
  discountType: "amount" | "percent";
  pricingMode: SalePricingMode;
};

export type CreateExchangeInput = {
  saleId: string;
  userId: string;
  clientTransactionId: string;
  items: ReturnItemInput[];
  refundMethod: "cash" | "original" | "credit" | "card" | "transfer";
  reason: string;
  note?: string;
  /** Replacement cart; null/empty = plain refund. */
  replacement?: ExchangeReplacement | null;
  /** External payments toward a positive net difference. */
  payments?: PaymentInput[];
  wholesaleAuthorized?: boolean;
  allowExpired?: boolean;
  requireApproval?: boolean;
};

export type ExchangeResult = {
  id: string;
  returnNumber: string;
  status: string;
  refundAmount: number;
  replacementTotal: number;
  /** Positive = customer paid; negative = customer received a refund. */
  netAmount: number;
  refundDue: number;
  replacementSaleId: string | null;
  replacementInvoiceNumber: string | null;
  bonusReversed: number;
  /** True when the idempotency key matched an already-processed request. */
  alreadyProcessed?: boolean;
};

type SaleDoc = {
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
};

function hasReplacement(replacement: ExchangeReplacement | null | undefined): boolean {
  return Boolean(replacement && (replacement.items.length > 0 || (replacement.directItems ?? []).length > 0));
}

function resultFromExisting(existing: {
  _id: mongoose.Types.ObjectId;
  returnNumber: string;
  status: string;
  total: number;
  replacementTotal: number;
  netAmount: number;
  exchangeSaleId: mongoose.Types.ObjectId | null;
  bonusReversed: number;
}): ExchangeResult {
  return {
    id: existing._id.toString(),
    returnNumber: existing.returnNumber,
    status: existing.status,
    refundAmount: existing.total,
    replacementTotal: existing.replacementTotal ?? 0,
    netAmount: existing.netAmount ?? -existing.total,
    refundDue: Math.max(0, round2(-(existing.netAmount ?? -existing.total))),
    replacementSaleId: existing.exchangeSaleId?.toString() ?? null,
    replacementInvoiceNumber: null,
    bonusReversed: existing.bonusReversed ?? 0,
  };
}

export async function createExchange(input: CreateExchangeInput): Promise<ExchangeResult> {
  await connectDB();

  const session = await mongoose.startSession();
  let result: ExchangeResult;

  try {
    await session.withTransaction(async () => {
      // --- Idempotent replay ---
      const existing = await SaleReturn.findOne({ clientTransactionId: input.clientTransactionId }).session(session).lean();
      if (existing) {
        result = {
          ...resultFromExisting(existing as unknown as Parameters<typeof resultFromExisting>[0]),
          alreadyProcessed: true,
        };
        return;
      }

      const sale = await Sale.findOne({ _id: input.saleId, status: "completed" }).session(session);
      if (!sale) {
        throw new ReturnValidationError("SALE_NOT_FOUND", "Sale not found or not eligible for return");
      }

      const { items: returnItems, subtotal: refundAmount } = await buildReturnItems(
        sale as unknown as SaleDoc,
        input.items,
        session
      );
      const effectiveRefundMethod = resolveRefundMethod(sale as unknown as SaleDoc, input.refundMethod);

      const replacement = hasReplacement(input.replacement) ? input.replacement! : null;
      // Exchanges hand over goods immediately; allowing a pending approval
      // would let the customer leave with the replacement before it is granted.
      if (replacement && input.requireApproval) {
        throw new ReturnValidationError(
          "EXCHANGE_APPROVAL_REQUIRED",
          "Exchanges cannot be held for approval. Disable refund approval or process a refund first."
        );
      }

      const status: "pending" | "approved" = !replacement && input.requireApproval ? "pending" : "approved";
      const returnNumber = `RET-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, "0")}-${Date.now().toString().slice(-8)}`;

      const returnDocs = await SaleReturn.create(
        [
          {
            returnNumber,
            clientTransactionId: input.clientTransactionId,
            saleId: sale._id,
            branchId: sale.branchId,
            customerId: sale.customerId,
            userId: input.userId,
            status,
            items: returnItems,
            subtotal: refundAmount,
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

      if (status === "pending") {
        result = {
          id: saleReturn._id.toString(),
          returnNumber,
          status,
          refundAmount,
          replacementTotal: 0,
          netAmount: -refundAmount,
          refundDue: refundAmount,
          replacementSaleId: null,
          replacementInvoiceNumber: null,
          bonusReversed: 0,
        };
        return;
      }

      // Restock first so an exchange can immediately sell a returned unit.
      await restockReturnItems(
        saleReturn as unknown as Parameters<typeof restockReturnItems>[0],
        sale.invoiceNumber,
        input.userId,
        session
      );

      let replacementSaleId: mongoose.Types.ObjectId | null = null;
      let replacementInvoiceNumber: string | null = null;
      let replacementTotal = 0;
      let refundDue = 0;
      let bonusReversed = 0;

      if (replacement) {
        const baseInput: CompleteSaleInput = {
          branchId: sale.branchId ? sale.branchId.toString() : null,
          customerId: sale.customerId ? sale.customerId.toString() : null,
          cashierId: input.userId,
          // A replacement sale stands in for the original transaction, so it
          // keeps that transaction's employee/department attribution.
          employeeId: sale.employeeId ? sale.employeeId.toString() : sale.cashierId.toString(),
          departmentId: sale.departmentId ? sale.departmentId.toString() : null,
          departmentName: sale.departmentName ?? "",
          items: replacement.items,
          directItems: replacement.directItems ?? [],
          discount: replacement.discount,
          discountType: replacement.discountType,
          payments: [],
          note: input.note ?? "",
          pricingMode: replacement.pricingMode,
          wholesaleAuthorized: input.wholesaleAuthorized,
          allowExpired: input.allowExpired,
          status: "held",
        };

        // First pass: server-side pricing and stock validation (no payment yet).
        // A held pass deliberately skips payment validation so the replacement
        // total is known before the exchange credit + difference are assembled.
        const priced = await prepareSale({ ...baseInput, status: "held" }, session);
        replacementTotal = priced.totals.total;

        const net = round2(replacementTotal - refundAmount);
        const exchangeCredit = round2(Math.min(refundAmount, replacementTotal));
        const externalPayments = input.payments ?? [];

        if (net > 0) {
          const externalTotal = round2(externalPayments.reduce((s, p) => s + p.amount, 0));
          if (externalTotal + 0.001 < net) {
            throw new ReturnValidationError(
              "EXCHANGE_UNDERPAID",
              `The replacement exceeds the refund by ${net.toFixed(2)}; collect that difference before completing the exchange`
            );
          }
        } else if (externalPayments.length > 0) {
          // No money should be collected when the refund covers the replacement.
          const externalTotal = round2(externalPayments.reduce((s, p) => s + p.amount, 0));
          if (externalTotal > 0.001) {
            throw new ReturnValidationError(
              "EXCHANGE_OVERPAID",
              "The refund covers the replacement; no additional payment is required"
            );
          }
        }

        const payments: PaymentInput[] = [
          ...(exchangeCredit > 0
            ? [{ method: "exchange" as const, amount: exchangeCredit, reference: returnNumber }]
            : []),
          ...(net > 0 ? externalPayments : []),
        ];

        // Second pass: full validation (payments, register, bonus, totals).
        const prepared = await prepareSale(
          { ...baseInput, status: "completed", payments },
          session
        );

        const persisted = await persistPreparedSale(prepared, session, {
          originalSaleId: sale._id.toString(),
          exchangeReturnId: saleReturn._id.toString(),
        });
        replacementSaleId = persisted.sale._id;
        replacementInvoiceNumber = persisted.invoiceNumber;

        if (net < 0) refundDue = round2(-net);

        saleReturn.exchangeSaleId = replacementSaleId;
        saleReturn.replacementTotal = replacementTotal;
        saleReturn.netAmount = net;

        // Net cash for the exchange: the replacement sale already recorded the
        // cash it collected. A refund larger than the replacement is paid out
        // here through the selected method.
        if (refundDue > 0) {
          if (effectiveRefundMethod === "cash") {
            await recordCashMovementIfDrawerOpen(
              {
                userId: input.userId,
                branchId: sale.branchId ? sale.branchId.toString() : null,
                type: "refund",
                amount: -refundDue,
                description: `Exchange refund ${returnNumber} for ${sale.invoiceNumber}`,
                referenceType: "sale_return",
                referenceId: saleReturn._id.toString(),
              },
              session
            );
          } else if (effectiveRefundMethod === "credit" && sale.customerId) {
            await appendLedgerEntry(
              {
                customerId: sale.customerId.toString(),
                branchId: sale.branchId ? sale.branchId.toString() : null,
                type: "REFUND",
                amount: -refundDue,
                referenceType: "sale_return",
                referenceId: saleReturn._id.toString(),
                description: `Store credit for exchange ${returnNumber}`,
                userId: input.userId,
              },
              session
            );
          }
        }
      } else {
        // Plain POS refund: no replacement sale.
        if (effectiveRefundMethod === "cash") {
          await recordCashMovementIfDrawerOpen(
            {
              userId: input.userId,
              branchId: sale.branchId ? sale.branchId.toString() : null,
              type: "refund",
              amount: -refundAmount,
              description: `Refund ${returnNumber} for ${sale.invoiceNumber}`,
              referenceType: "sale_return",
              referenceId: saleReturn._id.toString(),
            },
            session
          );
        } else if (effectiveRefundMethod === "credit" && sale.customerId) {
          await appendLedgerEntry(
            {
              customerId: sale.customerId.toString(),
              branchId: sale.branchId ? sale.branchId.toString() : null,
              type: "REFUND",
              amount: -refundAmount,
              referenceType: "sale_return",
              referenceId: saleReturn._id.toString(),
              description: `Store credit for refund ${returnNumber}`,
              userId: input.userId,
            },
            session
          );
        }
        saleReturn.netAmount = -refundAmount;
        refundDue = refundAmount;
      }

      // Proportional reward-credit clawback for this return.
      bonusReversed = await reverseBonusForReturn(
        sale as unknown as SaleDoc,
        saleReturn,
        input.userId,
        session
      );
      saleReturn.bonusReversed = bonusReversed;
      await saleReturn.save({ session });

      result = {
        id: saleReturn._id.toString(),
        returnNumber,
        status: "approved",
        refundAmount,
        replacementTotal,
        netAmount: round2(replacementTotal - refundAmount),
        refundDue,
        replacementSaleId: replacementSaleId?.toString() ?? null,
        replacementInvoiceNumber,
        bonusReversed,
      };
    });
  } finally {
    await session.endSession();
  }

  return result!;
}

/**
 * Sale lookup for the POS refund/exchange screen: original items, already
 * returned quantities and remaining returnable quantity per line.
 */
export async function lookupSaleForReturn(saleId: string) {
  await connectDB();

  const sale = await Sale.findById(saleId)
    .populate<{ customerId: { _id: mongoose.Types.ObjectId; name: string; phone: string } | null }>("customerId", "name phone")
    .lean();
  if (!sale) return null;

  const returns = await SaleReturn.find({ saleId: sale._id, status: { $in: ["pending", "approved"] } })
    .select("returnNumber status items total refundMethod createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const returnedByLine = new Map<string, number>();
  const returnedByProduct = new Map<string, number>();
  for (const saleReturn of returns) {
    for (const item of saleReturn.items) {
      const key = item.sourceLineId || "";
      if (key) returnedByLine.set(key, round2((returnedByLine.get(key) ?? 0) + item.quantity));
      if (item.productId) {
        const p = item.productId.toString();
        returnedByProduct.set(p, round2((returnedByProduct.get(p) ?? 0) + item.quantity));
      }
    }
  }

  return {
    sale: {
      _id: sale._id.toString(),
      invoiceNumber: sale.invoiceNumber,
      createdAt: sale.createdAt,
      status: sale.status,
      customerId: sale.customerId?._id?.toString() ?? null,
      customerName: sale.customerId?.name ?? null,
      customerPhone: sale.customerId?.phone ?? "",
      subtotal: sale.subtotal,
      discount: sale.discount,
      tax: sale.tax,
      total: sale.total,
      paidAmount: sale.paidAmount,
      paymentMethod: sale.paymentMethod,
      payments: sale.payments,
      pricingMode: sale.pricingMode ?? "retail",
      bonusEarned: sale.bonusEarned ?? 0,
      bonusRedeemed: sale.bonusRedeemed ?? 0,
      items: sale.items.map((rawItem) => {
        const item = rawItem as ISaleItemSnapshot & { _id?: mongoose.Types.ObjectId };
        const lineId = item._id ? item._id.toString() : `${item.productId ?? "direct"}:${item.sku}:${item.name}`;
        const returned = round2(
          (returnedByLine.get(lineId) ?? 0) +
            (item.productId && !returnedByLine.has(lineId) ? returnedByProduct.get(item.productId.toString()) ?? 0 : 0)
        );
        // Refund per unit as the customer actually paid it: wholesale price,
        // line/sale discounts and the employee benefit already deducted.
        const refund = lineRefundValue(sale as unknown as RefundableSale, item);
        return {
          lineId,
          productId: item.productId?.toString() ?? null,
          itemType: item.itemType ?? "inventory",
          pricingMode: item.pricingMode ?? "retail",
          name: item.name,
          sku: item.sku,
          quantity: item.quantity,
          sellingPrice: item.sellingPrice,
          discount: item.discount,
          tax: item.tax,
          subtotal: item.subtotal,
          linePaid: refund.paid,
          discountApplied: refund.discountApplied,
          unitRefund: item.quantity > 0 ? round2(refund.paid / item.quantity) : 0,
          returnedQuantity: returned,
          returnableQuantity: round2(Math.max(0, item.quantity - returned)),
        };
      }),
    },
    returns: returns.map((r) => ({
      _id: r._id.toString(),
      returnNumber: r.returnNumber,
      status: r.status,
      total: r.total,
      refundMethod: r.refundMethod,
      createdAt: r.createdAt,
      items: r.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        sourceLineId: i.sourceLineId,
        restock: i.restock,
      })),
    })),
  };
}

/** Reserved for tests/tools that need to assert no direct stock movement exists. */
export async function countReturnStockMovements(returnId: string): Promise<number> {
  return InventoryMovement.countDocuments({ referenceType: "return", referenceId: returnId });
}
