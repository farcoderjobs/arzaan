/**
 * Money/pricing engine — the single source of truth for sale math.
 * Used by both the POS API (server-authoritative totals) and the UI
 * (display only). Rounding is fixed to 2 decimals everywhere.
 */

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export type PricingItemInput = {
  productId: string;
  quantity: number;
  /** Discount for the line: absolute amount when discountType is "amount", percent 0-100 otherwise. */
  unitDiscount: number;
};

export type ServerProduct = {
  _id: string;
  name: string;
  sku: string;
  costPrice: number;
  sellingPrice: number;
  discountPrice: number;
  taxRate: number;
  currentStock: number;
};

export type PricingItemResult = {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  sellingPrice: number;
  costPrice: number;
  discount: number;
  tax: number;
  subtotal: number;
};

export type PricingResult = {
  items: PricingItemResult[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
};

export const MAX_DISCOUNT_PERCENT = 100;

export function validateUnitDiscounts(
  items: Array<{ unitDiscount: number }>,
  discountType: "amount" | "percent"
): string | null {
  for (let i = 0; i < items.length; i++) {
    const d = items[i].unitDiscount;
    if (!Number.isFinite(d) || d < 0) return `Invalid discount on item ${i + 1}`;
    if (discountType === "percent" && d > MAX_DISCOUNT_PERCENT) {
      return `Item ${i + 1}: percentage discount cannot exceed ${MAX_DISCOUNT_PERCENT}%`;
    }
  }
  return null;
}

export function validateSaleDiscount(discount: number, discountType: "amount" | "percent"): string | null {
  if (!Number.isFinite(discount) || discount < 0) return "Invalid sale discount";
  if (discountType === "percent" && discount > MAX_DISCOUNT_PERCENT) {
    return `Sale discount cannot exceed ${MAX_DISCOUNT_PERCENT}%`;
  }
  return null;
}

/**
 * Recomputes the whole sale from server-verified products.
 * Never trusts client totals — only productId/quantity/discount inputs.
 *
 * Effective unit price = discountPrice when set and cheaper (product-level promo),
 * else sellingPrice. Line discount applies on top (amount off the line, or % of the line).
 * Tax is per item at the product's taxRate on the discounted line.
 */
export function computeSaleTotals(
  items: PricingItemInput[],
  products: ServerProduct[],
  saleDiscount: number,
  discountType: "amount" | "percent"
): PricingResult {
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));
  const itemResults: PricingItemResult[] = [];
  let subtotal = 0;
  let tax = 0;
  let lineDiscountTotal = 0;

  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) throw new Error(`Product ${item.productId} not found`);

    const basePrice = product.discountPrice > 0 && product.discountPrice < product.sellingPrice
      ? product.discountPrice
      : product.sellingPrice;

    const gross = round2(basePrice * item.quantity);
    const lineDiscount =
      discountType === "percent"
        ? round2((gross * Math.min(item.unitDiscount, MAX_DISCOUNT_PERCENT)) / 100)
        : round2(Math.min(item.unitDiscount, gross));
    const net = round2(gross - lineDiscount);
    const lineTax = round2((net * product.taxRate) / 100);

    subtotal = round2(subtotal + gross);
    tax = round2(tax + lineTax);
    lineDiscountTotal = round2(lineDiscountTotal + lineDiscount);

    itemResults.push({
      productId: product._id.toString(),
      name: product.name,
      sku: product.sku,
      quantity: item.quantity,
      sellingPrice: basePrice,
      costPrice: product.costPrice,
      discount: round2(lineDiscount),
      tax: lineTax,
      subtotal: round2(net + lineTax),
    });
  }

  // Sale-level discount applies to the post-line-discount base.
  const effectiveBase = round2(subtotal - lineDiscountTotal);
  const saleDiscountAmount =
    discountType === "percent"
      ? round2((effectiveBase * Math.min(saleDiscount, MAX_DISCOUNT_PERCENT)) / 100)
      : round2(Math.min(saleDiscount, effectiveBase));
  // Stored discount includes line discounts so the invariant
  // total === subtotal - discount + tax holds for every sale.
  const discountAmount = round2(saleDiscountAmount + lineDiscountTotal);
  const total = round2(subtotal - discountAmount + tax);

  return {
    items: itemResults,
    subtotal,
    discount: discountAmount,
    tax,
    total,
  };
}

export const PAYMENT_METHODS = ["cash", "card", "transfer", "credit"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type PaymentInput = {
  method: PaymentMethod;
  amount: number;
  reference?: string;
};

/**
 * Validates payment split against server-computed total.
 * Returns an error string when invalid, null when ok.
 * - every payment amount must be > 0 and finite
 * - sum of non-cash payments + cash cannot exceed total (overpay only via cash change)
 * - non-cash methods cannot exceed the remaining balance
 */
export function validatePayments(
  payments: PaymentInput[],
  total: number,
  options: { allowOverpay?: boolean } = {}
): { ok: true; totalPaid: number } | { ok: false; error: string } {
  if (!payments || payments.length === 0) {
    return { ok: false, error: "At least one payment is required" };
  }

  let nonCash = 0;
  let cash = 0;
  let totalPaid = 0;

  for (const p of payments) {
    if (!PAYMENT_METHODS.includes(p.method)) {
      return { ok: false, error: `Invalid payment method: ${p.method}` };
    }
    if (!Number.isFinite(p.amount) || p.amount <= 0) {
      return { ok: false, error: "Payment amounts must be greater than zero" };
    }
    if (p.method === "cash") {
      cash = round2(cash + p.amount);
    } else {
      nonCash = round2(nonCash + p.amount);
    }
  }

  totalPaid = round2(cash + nonCash);

  // Non-cash cannot overpay — only cash can produce change.
  if (nonCash > total + 0.001) {
    return { ok: false, error: "Non-cash payments exceed the total. Only cash can produce change." };
  }

  if (totalPaid < total - 0.001 && !payments.some((p) => p.method === "credit")) {
    return { ok: false, error: "Total paid does not cover the sale total" };
  }

  if (options.allowOverpay === false && cash > total - nonCash + 0.001) {
    return { ok: false, error: "Cash received exceeds the remaining balance" };
  }

  return { ok: true, totalPaid };
}

/**
 * Splits the outcome of validatePayments into sale fields.
 * change is only ever produced by excess cash.
 */
export function computeSalePaymentFields(
  payments: PaymentInput[],
  total: number
): { paymentLines: Array<{ method: PaymentMethod; amount: number; reference: string }>; paidAmount: number; changeAmount: number; paymentMethod: PaymentMethod | "mixed" } {
  let paid = 0;
  let cash = 0;
  let nonCash = 0;
  const paymentLines: Array<{ method: PaymentMethod; amount: number; reference: string }> = [];

  for (const p of payments) {
    const amount = round2(p.amount);
    paid = round2(paid + amount);
    if (p.method === "cash") cash = round2(cash + amount);
    else nonCash = round2(nonCash + amount);
    paymentLines.push({ method: p.method, amount, reference: (p.reference ?? "").slice(0, 200) });
  }

  const changeAmount = cash > 0 ? round2(Math.max(0, cash - Math.max(0, total - nonCash))) : 0;
  // paidAmount counts only what actually settles the sale (excluding change given back)
  const effectivePaid = round2(Math.min(paid - changeAmount, total));
  const method = paymentLines.length === 1 ? paymentLines[0].method : "mixed";

  return { paymentLines, paidAmount: effectivePaid, changeAmount, paymentMethod: method };
}

export function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
