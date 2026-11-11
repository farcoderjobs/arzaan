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
  /**
   * Automatic offer discount resolved from active DiscountOffer documents.
   * Always a percentage of the line, added to the manual line discount and to
   * the sale-level discount. Never counted as a cashier discount.
   */
  offerDiscountPercent?: number;
};

export type SalePricingMode = "retail" | "wholesale";

export type ServerProduct = {
  _id: string;
  name: string;
  sku: string;
  costPrice: number;
  sellingPrice: number;
  /** Stored wholesale price (`discountPrice` in the database). */
  wholesalePrice: number;
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
  pricingMode: SalePricingMode;
};

/** Thrown when wholesale mode is requested for a product with no wholesale price. */
export class WholesalePriceUnavailableError extends Error {
  productName: string;
  constructor(productName: string) {
    super(`${productName} has no wholesale price configured`);
    this.name = "WholesalePriceUnavailableError";
    this.productName = productName;
  }
}

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
 * Pricing mode is explicit: `retail` always uses sellingPrice and `wholesale`
 * always uses the stored wholesale price. A product without a positive
 * wholesale price is rejected rather than silently priced at zero.
 * Line discount applies on top (amount off the line, or % of the line).
 * Tax is per item at the product's taxRate on the discounted line.
 */
export function computeSaleTotals(
  items: PricingItemInput[],
  products: ServerProduct[],
  saleDiscount: number,
  discountType: "amount" | "percent",
  pricingMode: SalePricingMode = "retail"
): PricingResult {
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));
  const itemResults: PricingItemResult[] = [];
  let subtotal = 0;
  let tax = 0;
  let lineDiscountTotal = 0;

  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) throw new Error(`Product ${item.productId} not found`);

    const basePrice =
      pricingMode === "wholesale"
        ? product.wholesalePrice > 0
          ? product.wholesalePrice
          : (() => { throw new WholesalePriceUnavailableError(product.name); })()
        : product.sellingPrice;

    const gross = round2(basePrice * item.quantity);
    const manualDiscount =
      discountType === "percent"
        ? round2((gross * Math.min(item.unitDiscount, MAX_DISCOUNT_PERCENT)) / 100)
        : round2(Math.min(item.unitDiscount, gross));
    // Automatic offer discount is always a percentage of the line value and is
    // deducted before tax, exactly like a manual line discount.
    const offerPercent = Math.min(Math.max(0, item.offerDiscountPercent ?? 0), MAX_DISCOUNT_PERCENT);
    const offerDiscount = round2((gross * offerPercent) / 100);
    const lineDiscount = round2(Math.min(gross, manualDiscount + offerDiscount));
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
      pricingMode,
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

/**
 * Direct-sale items: goods bought in the market and sold without ever entering
 * stock. They are priced server-side from the validated input — never from
 * client-calculated totals — and never create inventory movements.
 */
export type DirectItemInput = {
  description: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  taxRate: number;
};

export type DirectItemResult = {
  productId: null;
  itemType: "direct";
  name: string;
  sku: string;
  quantity: number;
  sellingPrice: number;
  costPrice: number;
  discount: number;
  tax: number;
  subtotal: number;
  /** Direct-sale lines are negotiated at the counter, never a catalog tier. */
  pricingMode: "retail";
};

export function computeDirectItemTotals(items: DirectItemInput[]): {
  items: DirectItemResult[];
  subtotal: number;
  tax: number;
} {
  let subtotal = 0;
  let tax = 0;
  const results: DirectItemResult[] = [];

  for (const item of items) {
    const quantity = Math.max(0, Math.floor(item.quantity));
    const unitPrice = round2(Math.max(0, item.unitPrice));
    const unitCost = round2(Math.max(0, item.unitCost));
    const taxRate = Math.min(100, Math.max(0, item.taxRate));
    const gross = round2(unitPrice * quantity);
    const lineTax = round2((gross * taxRate) / 100);

    subtotal = round2(subtotal + gross);
    tax = round2(tax + lineTax);

    results.push({
      productId: null,
      itemType: "direct",
      name: item.description.trim().slice(0, 200),
      sku: "DIRECT",
      quantity,
      sellingPrice: unitPrice,
      costPrice: unitCost,
      discount: 0,
      tax: lineTax,
      subtotal: round2(gross + lineTax),
      pricingMode: "retail",
    });
  }

  return { items: results, subtotal, tax };
}

export const PAYMENT_METHODS = ["cash", "card", "transfer", "credit", "bonus", "exchange"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Methods a client may submit directly. `exchange` is issued only by the server. */
export const CLIENT_PAYMENT_METHODS = ["cash", "card", "transfer", "credit", "bonus"] as const;

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
  let credit = 0;

  for (const p of payments) {
    if (!PAYMENT_METHODS.includes(p.method)) {
      return { ok: false, error: `Invalid payment method: ${p.method}` };
    }
    if (!Number.isFinite(p.amount) || p.amount <= 0) {
      return { ok: false, error: "Payment amounts must be greater than zero" };
    }
    if (p.method === "cash") {
      cash = round2(cash + p.amount);
    } else if (p.method === "credit") {
      credit = round2(credit + p.amount);
    } else {
      // card, transfer, bonus credit and exchange credit can never overpay.
      nonCash = round2(nonCash + p.amount);
    }
  }

  const totalPaid = round2(cash + nonCash + credit);

  // Non-cash cannot overpay — only cash can produce change.
  if (nonCash > total + 0.001) {
    return { ok: false, error: "Non-cash payments exceed the total. Only cash can produce change." };
  }

  if (credit > 0) {
    // Credit covers the remainder and creates customer debt. Every tender must
    // add up exactly to the total (cash overpay alongside credit is rejected).
    const covered = round2(cash + nonCash);
    if (covered > total + 0.001) {
      return { ok: false, error: "Payments exceed the total alongside credit" };
    }
    if (round2(covered + credit) < total - 0.001) {
      return { ok: false, error: "Total paid does not cover the sale total" };
    }
    if (round2(covered + credit) > total + 0.001) {
      return { ok: false, error: "Payments exceed the sale total" };
    }
    return { ok: true, totalPaid };
  }

  if (totalPaid < total - 0.001) {
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
): {
  paymentLines: Array<{ method: PaymentMethod; amount: number; reference: string }>;
  paidAmount: number;
  changeAmount: number;
  paymentMethod: PaymentMethod | "mixed" | null;
} {
  let paid = 0;
  let cash = 0;
  let nonCash = 0;
  const paymentLines: Array<{ method: PaymentMethod; amount: number; reference: string }> = [];

  for (const p of payments) {
    const amount = round2(p.amount);
    // Zero-amount tenders are not payments: an employee purchase paid entirely
    // on account arrives with an empty (or all-zero) tender list.
    if (amount <= 0) continue;
    paid = round2(paid + amount);
    if (p.method === "cash") cash = round2(cash + amount);
    else nonCash = round2(nonCash + amount);
    paymentLines.push({ method: p.method, amount, reference: (p.reference ?? "").slice(0, 200) });
  }

  const changeAmount = cash > 0 ? round2(Math.max(0, cash - Math.max(0, total - nonCash))) : 0;
  // paidAmount counts only what actually settles the sale (excluding change given back)
  const effectivePaid = round2(Math.min(paid - changeAmount, total));
  const method =
    paymentLines.length === 0 ? null : paymentLines.length === 1 ? paymentLines[0].method : "mixed";

  return { paymentLines, paidAmount: effectivePaid, changeAmount, paymentMethod: method };
}

export function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Customer reward credit (bonus)
// ---------------------------------------------------------------------------

/**
 * Bonus is earned on merchandise value, never on tax or on the portion paid
 * with bonus credit. `amount_paid` also includes tax (but still excludes the
 * bonus-funded portion), which stores can opt into via settings.
 */
export type BonusEarnBasis = "net_merchandise" | "amount_paid";

export function computeBonusEarnBase(input: {
  subtotal: number;
  discount: number;
  total: number;
  bonusRedeemed: number;
  basis: BonusEarnBasis;
}): number {
  const merchandise = round2(input.subtotal - input.discount);
  const base =
    input.basis === "amount_paid"
      ? round2(input.total - input.bonusRedeemed)
      : round2(merchandise - input.bonusRedeemed);
  return Math.max(0, base);
}

export function computeBonusEarned(base: number, percent: number): number {
  const safePercent = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  const safeBase = Math.max(0, Number.isFinite(base) ? base : 0);
  return round2((safeBase * safePercent) / 100);
}

/**
 * Proportional reversal for a return. Returns how much of the sale's earned
 * bonus should be clawed back by this return, never exceeding the un-reversed
 * remainder of the original earn.
 */
export function computeBonusReversal(input: {
  earned: number;
  refundAmount: number;
  saleTotal: number;
  alreadyReversed: number;
}): number {
  if (input.earned <= 0 || input.saleTotal <= 0 || input.refundAmount <= 0) return 0;
  const proportional = round2((input.earned * input.refundAmount) / input.saleTotal);
  const remaining = round2(Math.max(0, input.earned - input.alreadyReversed));
  return round2(Math.max(0, Math.min(proportional, remaining)));
}
