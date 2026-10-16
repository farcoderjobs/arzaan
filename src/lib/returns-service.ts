import mongoose from "mongoose";
import { Sale, SaleReturn, InventoryMovement, ISaleItemSnapshot } from "@/models";
import { round2 } from "@/lib/commerce";
import { appendLedgerEntry } from "@/lib/customer-ledger";
import { recordCashMovementIfDrawerOpen } from "@/lib/finance-service";
import { connectDB } from "@/lib/mongodb";

/**
 * Sale return service.
 *
 * Rules enforced here:
 *  - Cannot return more than originally sold (accounting for previous approved returns).
 *  - Original sale is never modified or deleted.
 *  - Returned stock creates CUSTOMER_RETURN_IN inventory movements.
 *  - Refunds create a REFUND customer ledger entry when the customer is on credit.
 *  - Duplicate return processing is prevented by re-validating quantities inside the transaction.
 *  - Manager approval is required when the settings flag `returns.requireApproval` is on.
 */

export type ReturnItemInput = {
  productId: string;
  quantity: number;
};

export type CreateReturnInput = {
  saleId: string;
  userId: string;
  items: ReturnItemInput[];
  refundMethod: "cash" | "original" | "credit";
  reason: string;
  note?: string;
  requireApproval?: boolean;
};

export class ReturnValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function getReturnedQuantities(
  saleId: string,
  session?: mongoose.ClientSession | null
): Promise<Map<string, number>> {
  const pipeline = [
    { $match: { saleId: new mongoose.Types.ObjectId(saleId), status: { $in: ["pending", "approved"] } } },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.productId",
        quantity: { $sum: "$items.quantity" },
      },
    },
  ];
  const results = session
    ? await SaleReturn.aggregate(pipeline).session(session)
    : await SaleReturn.aggregate(pipeline);

  const map = new Map<string, number>();
  for (const r of results) {
    map.set(r._id.toString(), r.quantity);
  }
  return map;
}

export async function createSaleReturn(input: CreateReturnInput) {
  await connectDB();

  const session = await mongoose.startSession();
  let created: { id: string; returnNumber: string; total: number; status: string; refundAmount: number };

  try {
    await session.withTransaction(async () => {
      const sale = await Sale.findOne({ _id: input.saleId, status: "completed" }).session(session);
      if (!sale) {
        throw new ReturnValidationError("SALE_NOT_FOUND", "Sale not found or not eligible for return");
      }

      if (!input.items || input.items.length === 0) {
        throw new ReturnValidationError("EMPTY_RETURN", "At least one item is required for a return");
      }

      // Previously returned quantities (approved + pending returns count toward the limit)
      const returnedMap = await getReturnedQuantities(input.saleId, session);

      const saleItemMap = new Map<string, ISaleItemSnapshot>(
        sale.items.map((i) => [i.productId.toString(), i])
      );

      const returnItems: ISaleItemSnapshot[] = [];
      for (const item of input.items) {
        const saleItem = saleItemMap.get(item.productId);
        if (!saleItem) {
          throw new ReturnValidationError("ITEM_NOT_ON_SALE", "Returned item was not part of the original sale");
        }
        if (!Number.isInteger(item.quantity) || item.quantity < 1) {
          throw new ReturnValidationError("INVALID_QUANTITY", "Return quantity must be a whole number of at least 1");
        }
        const alreadyReturned = returnedMap.get(item.productId) ?? 0;
        if (alreadyReturned + item.quantity > saleItem.quantity) {
          throw new ReturnValidationError(
            "EXCEEDS_SOLD_QUANTITY",
            `Cannot return ${item.quantity} of ${saleItem.name}: only ${saleItem.quantity - alreadyReturned} remaining returnable`
          );
        }
        // Snapshot from the ORIGINAL sale — price the customer actually paid
        const lineTotal = round2(saleItem.subtotal * (item.quantity / saleItem.quantity));
        returnItems.push({
          productId: saleItem.productId,
          name: saleItem.name,
          sku: saleItem.sku,
          quantity: item.quantity,
          sellingPrice: saleItem.sellingPrice,
          costPrice: saleItem.costPrice,
          discount: saleItem.discount,
          tax: saleItem.tax,
          subtotal: lineTotal,
        });
      }

      const subtotal = round2(returnItems.reduce((sum, i) => sum + i.subtotal, 0));

      // refund amounts — proportional part of item tax/discount already inside subtotal
      const refundAmount = subtotal;

      const requireApproval = input.requireApproval ?? false;
      const status: "pending" | "approved" = requireApproval ? "pending" : "approved";
      const returnNumber = `RET-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, "0")}-${Date.now().toString().slice(-8)}`;

      const returnDocs = await SaleReturn.create(
        [
          {
            returnNumber,
            saleId: sale._id,
            branchId: sale.branchId,
            customerId: sale.customerId,
            userId: input.userId,
            status,
            items: returnItems,
            subtotal,
            discount: 0,
            tax: 0,
            total: refundAmount,
            refundMethod: input.refundMethod,
            reason: input.reason.slice(0, 300),
            note: (input.note ?? "").slice(0, 300),
            approvedBy: status === "approved" ? input.userId : null,
            approvedAt: status === "approved" ? new Date() : null,
          },
        ],
        { session }
      );
      const saleReturn = returnDocs[0];

      // Side effects only once the return is approved
      if (status === "approved") {
        // Stock re-entry
        const movementDocs = returnItems.map((item) => ({
          productId: item.productId,
          branchId: sale.branchId,
          movementType: "CUSTOMER_RETURN_IN",
          quantity: item.quantity,
          unitCost: item.costPrice,
          referenceType: "return",
          referenceId: saleReturn._id,
          note: `Return ${returnNumber} for ${sale.invoiceNumber}`,
          userId: new mongoose.Types.ObjectId(input.userId),
        }));
        await InventoryMovement.insertMany(movementDocs, { session });

        // Financial transaction: refund to customer
        if (sale.customerId) {
          if (input.refundMethod === "credit") {
            // Store credit → the customer's outstanding balance decreases
            await appendLedgerEntry(
              {
                customerId: sale.customerId.toString(),
                branchId: sale.branchId ? sale.branchId.toString() : null,
                type: "REFUND",
                amount: -refundAmount,
                referenceType: "sale_return",
                referenceId: saleReturn._id.toString(),
                description: `Refund (store credit) for ${sale.invoiceNumber} — ${returnNumber}`,
                userId: input.userId,
              },
              session
            );
          } else if (sale.paymentMethod === "credit" || hasCreditPayment(sale)) {
            // The original sale had an outstanding credit portion; paying cash/original
            // also settles their balance.
            await appendLedgerEntry(
              {
                customerId: sale.customerId.toString(),
                branchId: sale.branchId ? sale.branchId.toString() : null,
                type: "REFUND",
                amount: -refundAmount,
                referenceType: "sale_return",
                referenceId: saleReturn._id.toString(),
                description: `Refund for ${sale.invoiceNumber} — ${returnNumber}`,
                userId: input.userId,
              },
              session
            );
          }
        }

        // Cash refunds physically leave the drawer (recorded even when the customer
        // paid by card — the drawer is the source of truth for cash on hand).
        if (input.refundMethod === "cash") {
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
        }
      }

      created = {
        id: saleReturn._id.toString(),
        returnNumber,
        total: refundAmount,
        status,
        refundAmount,
      };
    });
  } finally {
    await session.endSession();
  }

  return created!;
}

function hasCreditPayment(sale: { payments: Array<{ method: string; amount: number }> }): boolean {
  return (sale.payments ?? []).some((p) => p.method === "credit" && p.amount > 0);
}

/**
 * Approves or rejects a pending return (manager action).
 * Side effects are applied at approval time.
 */
export async function approveSaleReturn(returnId: string, approverUserId: string) {
  await connectDB();
  const session = await mongoose.startSession();
  let result: { id: string; status: string };

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

      // Re-validate returnable quantities at approval time
      const returnedMap = await getReturnedQuantities(saleReturn.saleId.toString(), session);
      const saleItemMap = new Map<string, ISaleItemSnapshot>(sale.items.map((i) => [i.productId.toString(), i]));
      for (const item of saleReturn.items) {
        const saleItem = saleItemMap.get(item.productId.toString());
        const alreadyReturned = returnedMap.get(item.productId.toString()) ?? 0;
        const thisReturnCount = item.quantity;
        if (!saleItem || alreadyReturned + thisReturnCount > saleItem.quantity) {
          throw new ReturnValidationError("EXCEEDS_SOLD_QUANTITY", "Approval would exceed the originally sold quantity");
        }
      }

      saleReturn.status = "approved";
      saleReturn.approvedBy = new mongoose.Types.ObjectId(approverUserId);
      saleReturn.approvedAt = new Date();
      await saleReturn.save({ session });

      const refundAmount = saleReturn.total;

      const movementDocs = saleReturn.items.map((item) => ({
        productId: item.productId,
        branchId: saleReturn.branchId,
        movementType: "CUSTOMER_RETURN_IN",
        quantity: item.quantity,
        unitCost: item.costPrice,
        referenceType: "return",
        referenceId: saleReturn._id,
        note: `Return ${saleReturn.returnNumber} for ${sale.invoiceNumber}`,
        userId: new mongoose.Types.ObjectId(approverUserId),
      }));
      await InventoryMovement.insertMany(movementDocs, { session });

      if (sale.customerId && (sale.paymentMethod === "credit" || hasCreditPayment(sale))) {
        await appendLedgerEntry(
          {
            customerId: sale.customerId.toString(),
            branchId: saleReturn.branchId ? saleReturn.branchId.toString() : null,
            type: "REFUND",
            amount: -refundAmount,
            referenceType: "sale_return",
            referenceId: saleReturn._id.toString(),
            description: `Refund for ${sale.invoiceNumber} — ${saleReturn.returnNumber}`,
            userId: approverUserId,
          },
          session
        );
      }

      // Cash refunds physically leave the drawer — same rule as the instant path.
      if (saleReturn.refundMethod === "cash") {
        await recordCashMovementIfDrawerOpen(
          {
            userId: approverUserId,
            branchId: saleReturn.branchId ? saleReturn.branchId.toString() : null,
            type: "refund",
            amount: -refundAmount,
            description: `Refund ${saleReturn.returnNumber} for ${sale.invoiceNumber}`,
            referenceType: "sale_return",
            referenceId: saleReturn._id.toString(),
          },
          session
        );
      }

      result = { id: saleReturn._id.toString(), status: "approved" };
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
