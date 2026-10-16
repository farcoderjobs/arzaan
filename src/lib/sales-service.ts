import mongoose from "mongoose";
import { Sale, SaleReturn, Product, InventoryMovement, CashRegister, ISalePayment } from "@/models";
import { computeSaleTotals, computeSalePaymentFields, round2, PaymentMethod, PaymentInput } from "@/lib/commerce";
import { appendLedgerEntry } from "@/lib/customer-ledger";
import { generateDocumentNumber } from "@/lib/document-number";
import { connectDB } from "@/lib/mongodb";
import { addCashTransaction } from "@/lib/cash-register";

/**
 * Sale service shared by POS checkout and returns.
 * All money math lives in @/lib/commerce; this file persists documents
 * inside a MongoDB transaction so a sale and its side effects are atomic.
 */

export type CompleteSaleInput = {
  branchId: string | null;
  customerId: string | null;
  cashierId: string;
  items: Array<{ productId: string; quantity: number; unitDiscount: number }>;
  discount: number;
  discountType: "amount" | "percent";
  payments: PaymentInput[];
  note: string;
  status?: "completed" | "held";
  /** Client-generated idempotency key (offline sync) — stored on the sale. */
  clientTransactionId?: string | null;
  /** Device that captured the sale offline — stored for traceability. */
  deviceId?: string | null;
};

export type CompleteSaleResult = {
  id: string;
  invoiceNumber: string;
  total: number;
  paidAmount: number;
  changeAmount: number;
  status: string;
  creditUsed: number;
};

export class SaleValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Computes current stock for a product from inventory movements (never trusts a stored field).
 */
export async function getStockForProducts(
  productIds: string[],
  branchId: string | null
): Promise<Map<string, number>> {
  const match: Record<string, unknown> = { productId: { $in: productIds.map((id) => new mongoose.Types.ObjectId(id)) } };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);

  const results = await InventoryMovement.aggregate<{ _id: string; stock: number }>([
    { $match: match },
    {
      $group: {
        _id: "$productId",
        stock: {
          $sum: {
            $cond: [
              { $in: ["$movementType", ["PURCHASE_IN", "CUSTOMER_RETURN_IN", "ADJUSTMENT_IN", "STOCK_COUNT_IN"]] },
              "$quantity",
              { $multiply: ["$quantity", -1] },
            ],
          },
        },
      },
    },
  ]);

  const map = new Map<string, number>();
  for (const r of results) {
    map.set(r._id.toString(), r.stock);
  }
  return map;
}

const OUT_TYPES = ["PURCHASE_IN", "CUSTOMER_RETURN_IN", "ADJUSTMENT_IN", "STOCK_COUNT_IN"] as const;

export async function completeSale(input: CompleteSaleInput): Promise<CompleteSaleResult> {
  await connectDB();

  const session = await mongoose.startSession();
  let result: CompleteSaleResult;

  try {
    await session.withTransaction(async () => {
      // 1. Fetch and verify products server-side
      const productIds = [...new Set(input.items.map((i) => i.productId))];
      const products = await Product.find({ _id: { $in: productIds }, status: "active" }).session(session).lean();
      const productMap = new Map(products.map((p) => [p._id.toString(), p]));

      for (const item of input.items) {
        const product = productMap.get(item.productId);
        if (!product) {
          throw new SaleValidationError("PRODUCT_NOT_FOUND", "One or more products are unavailable");
        }
        if (!Number.isInteger(item.quantity) || item.quantity < 1) {
          throw new SaleValidationError("INVALID_QUANTITY", "Quantity must be a whole number of at least 1");
        }
      }

      // 2. Verify stock from movements
      const stockMap = await getStockForProductsInSession(productIds, branchIdOrNull(input.branchId), session);
      for (const item of input.items) {
        const available = stockMap.get(item.productId) ?? 0;
        if (available < item.quantity) {
          const product = productMap.get(item.productId)!;
          throw new SaleValidationError(
            "INSUFFICIENT_STOCK",
            `Insufficient stock for ${product.name} (${available} available)`
          );
        }
      }

      // 3. Server recalculates every total — client values are ignored
      const serverItems = input.items.map((item) => {
        const product = productMap.get(item.productId)!;
        return {
          productId: item.productId,
          quantity: item.quantity,
          unitDiscount: item.unitDiscount,
          sellingPrice: product.sellingPrice,
        };
      });
      const pricingInputs = input.items.map((item, idx) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitDiscount: item.unitDiscount,
        sellingPrice: serverItems[idx].sellingPrice,
      }));
      const totals = computeSaleTotals(pricingInputs, serverProductAdapter(products), input.discount, input.discountType);

      const status = input.status ?? "completed";

      // 4. Validate payments against server total
      let paymentFields: ReturnType<typeof computeSalePaymentFields> | null = null;
      let creditUsed = 0;
      if (status === "completed") {
        const creditPayment = input.payments.find((p) => p.method === "credit");
        if (creditPayment) {
          if (!input.customerId) {
            throw new SaleValidationError("CREDIT_REQUIRES_CUSTOMER", "Credit sales require a customer");
          }
          // A credit sale CREATES debt for the customer — it is allowed regardless of
          // their current outstanding balance. The credit portion is recorded as a
          // SALE ledger entry (positive = customer owes more). The "payment ≤
          // outstanding" rule only applies to customer PAYMENT transactions, which is
          // enforced in the customers API.
          creditUsed = round2(creditPayment.amount);
        }

        const validation = validatePaymentsServer(input.payments, totals.total);
        if (!validation.ok) throw new SaleValidationError("INVALID_PAYMENT", validation.error);

        paymentFields = computeSalePaymentFields(input.payments, totals.total);
      }

      // 5. Persist the sale
      const invoiceNumber = await generateDocumentNumber("INV", session);

      // 5a. Every cash sale must link to the cashier's active register.
      // Non-cash sales only attach when a register happens to be open.
      const cashPortion = round2(input.payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0));
      let registerId: mongoose.Types.ObjectId | null = null;
      if (status === "completed") {
        const openRegister = await CashRegister.findOne({
          openedBy: new mongoose.Types.ObjectId(input.cashierId),
          status: "open",
        })
          .sort({ openedAt: -1 })
          .session(session);
        if (cashPortion > 0 && !openRegister) {
          throw new SaleValidationError(
            "NO_OPEN_REGISTER",
            "A cash sale requires an open cash register. Open your register first."
          );
        }
        if (openRegister) {
          registerId = openRegister._id;
        }
      }          const saleDocs = await Sale.create(
        [
          {
            invoiceNumber,
            clientTransactionId: input.clientTransactionId ?? null,
            deviceId: input.deviceId ?? null,
            branchId: input.branchId,
            registerId,
            customerId: input.customerId,
            cashierId: input.cashierId,
            status,
            items: totals.items,
            subtotal: totals.subtotal,
            discount: totals.discount,
            discountType: input.discountType,
            tax: totals.tax,
            total: totals.total,
            paidAmount: paymentFields?.paidAmount ?? 0,
            changeAmount: paymentFields?.changeAmount ?? 0,
            paymentMethod: paymentFields?.paymentMethod ?? null,
            payments: (paymentFields?.paymentLines ?? []) as unknown as ISalePayment[],
            heldAt: status === "held" ? new Date() : null,
            heldBy: status === "held" ? input.cashierId : null,
            note: input.note.slice(0, 500),
          },
        ],
        { session }
      );
      const sale = saleDocs[0];

      // 6. Inventory movements (sale out) — cost price snapshot is in the sale items
      if (status === "completed") {
        const movementDocs = totals.items.map((item) => ({
          productId: new mongoose.Types.ObjectId(item.productId),
          branchId: input.branchId ? new mongoose.Types.ObjectId(input.branchId) : null,
          movementType: "SALE_OUT",
          quantity: item.quantity,
          unitCost: item.costPrice,
          referenceType: "sale",
          referenceId: sale._id,
          note: `Sale ${invoiceNumber}`,
          userId: new mongoose.Types.ObjectId(input.cashierId),
        }));
        await InventoryMovement.insertMany(movementDocs, { session });

        // 7. Customer ledger entry for the credit portion
        if (creditUsed > 0 && input.customerId) {
          await appendLedgerEntry(
            {
              customerId: input.customerId,
              branchId: input.branchId,
              type: "SALE",
              amount: creditUsed,
              referenceType: "sale",
              referenceId: sale._id.toString(),
              description: `Credit sale ${invoiceNumber}`,
              userId: input.cashierId,
            },
            session
          );
        }

        // 8. Cash drawer movement — net cash the drawer should physically hold for
        // this sale (cash received minus change handed back).
        if (registerId && cashPortion > 0) {
          const cashIn = round2(cashPortion - (paymentFields?.changeAmount ?? 0));
          if (cashIn !== 0) {
            await addCashTransaction(
              {
                registerId: registerId.toString(),
                userId: input.cashierId,
                type: "sale",
                amount: cashIn,
                description: `Sale ${invoiceNumber}`,
                referenceType: "sale",
                referenceId: sale._id.toString(),
                branchId: input.branchId,
              },
              session
            );
          }
        }
      }

      result = {
        id: sale._id.toString(),
        invoiceNumber,
        total: totals.total,
        paidAmount: paymentFields?.paidAmount ?? 0,
        changeAmount: paymentFields?.changeAmount ?? 0,
        status,
        creditUsed,
      };
    }, {
      readPreference: "primary",
      readConcern: { level: "majority" },
      writeConcern: { w: "majority" },
    });
  } finally {
    await session.endSession();
  }

  return result!;
}

function branchIdOrNull(branchId: string | null): string | null {
  return branchId ?? null;
}

type LeanProduct = {
  _id: mongoose.Types.ObjectId;
  name: string;
  sku: string;
  costPrice: number;
  sellingPrice: number;
  discountPrice: number;
  taxRate: number;
};

function serverProductAdapter(products: LeanProduct[]) {
  return products.map((p) => ({
    _id: p._id.toString(),
    name: p.name,
    sku: p.sku,
    costPrice: p.costPrice,
    sellingPrice: p.sellingPrice,
    discountPrice: p.discountPrice,
    taxRate: p.taxRate,
    currentStock: 0,
  }));
}

async function getStockForProductsInSession(
  productIds: string[],
  branchId: string | null,
  session: mongoose.ClientSession
): Promise<Map<string, number>> {
  const match: Record<string, unknown> = { productId: { $in: productIds.map((id) => new mongoose.Types.ObjectId(id)) } };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);

  const results = await InventoryMovement.aggregate<{ _id: string; stock: number }>(
    [
      { $match: match },
      {
        $group: {
          _id: "$productId",
          stock: {
            $sum: {
              $cond: [{ $in: ["$movementType", OUT_TYPES] }, "$quantity", { $multiply: ["$quantity", -1] }],
            },
          },
        },
      },
    ],
    { session }
  );

  const map = new Map<string, number>();
  for (const r of results) map.set(r._id.toString(), r.stock);
  return map;
}

function validatePaymentsServer(
  payments: PaymentInput[],
  total: number
): { ok: true } | { ok: false; error: string } {
  if (!payments || payments.length === 0) return { ok: false, error: "At least one payment is required" };

  let nonCash = 0;
  let cash = 0;
  let totalPaid = 0;
  let hasCredit = false;

  for (const p of payments) {
    if (!["cash", "card", "transfer", "credit"].includes(p.method)) {
      return { ok: false, error: `Invalid payment method: ${p.method}` };
    }
    if (!Number.isFinite(p.amount) || p.amount <= 0) {
      return { ok: false, error: "Payment amounts must be greater than zero" };
    }
    if (p.method === "cash") cash = round2(cash + p.amount);
    else if (p.method === "credit") hasCredit = true;
    else nonCash = round2(nonCash + p.amount);
  }

  totalPaid = round2(cash + nonCash + (hasCredit ? total : 0));

  if (nonCash > total + 0.001) {
    return { ok: false, error: "Non-cash payments exceed the total. Only cash can produce change." };
  }

  if (hasCredit) {
    // Credit covers part/all of the total and creates customer debt; the covered
    // portion (cash + non-cash) plus the credit amount must equal the sale total.
    const covered = round2(cash + nonCash);
    const creditAmount = round2(payments.filter((p) => p.method === "credit").reduce((s, p) => s + p.amount, 0));
    if (covered > total + 0.001) {
      return { ok: false, error: "Payments exceed the total alongside credit" };
    }
    if (round2(covered + creditAmount) < total - 0.001) {
      return { ok: false, error: "Total paid does not cover the sale total" };
    }
    if (round2(covered + creditAmount) > total + 0.001) {
      return { ok: false, error: "Payments exceed the sale total" };
    }
    return { ok: true };
  }

  if (totalPaid < total - 0.001) {
    return { ok: false, error: "Total paid does not cover the sale total" };
  }

  return { ok: true };
}

export type { ISalePayment, PaymentMethod as SalePaymentMethod };
export { SaleReturn };
