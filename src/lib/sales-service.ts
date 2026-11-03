import mongoose from "mongoose";
import {
  Sale,
  SaleReturn,
  Product,
  Customer,
  InventoryMovement,
  CashRegister,
  Branch,
  Department,
  User,
  ISalePayment,
  PurchaseSource,
} from "@/models";
import {
  computeSaleTotals,
  computeSalePaymentFields,
  computeDirectItemTotals,
  computeBonusEarnBase,
  computeBonusEarned,
  round2,
  PaymentMethod,
  PaymentInput,
  DirectItemInput,
  SalePricingMode,
  WholesalePriceUnavailableError,
  PricingItemResult,
} from "@/lib/commerce";
import { allocateQuantity, sellableQuantity, expiredQuantity } from "@/lib/expiry";
import { getProductBatches } from "@/lib/inventory-batches";
import { appendLedgerEntry } from "@/lib/customer-ledger";
import { appendBonusEntry, expireCustomerBonus } from "@/lib/bonus";
import { generateDocumentNumber } from "@/lib/document-number";
import { connectDB } from "@/lib/mongodb";
import { addCashTransaction } from "@/lib/cash-register";
import { getStoreSettings } from "@/lib/settings";
import {
  DEFAULT_CUSTOMER_BONUS_POLICY,
  DEFAULT_EMPLOYEE_BENEFIT_POLICY,
  computeBonusRedemptionLimit,
  computeCustomerBonus,
  computeEmployeeBenefit,
  checkEmployeeMonthlyLimit,
  normalizeMethods,
  parseCsv,
  bonusExpiryDate,
  type BonusLineForEligibility,
} from "@/lib/bonus-policy";
import {
  createEmployeePurchaseForSale,
  employeeMonthlyPurchaseTotal,
  getEmployeeBenefitPolicy,
  periodOf,
} from "@/lib/employee-purchase";

/**
 * Sale service shared by POS checkout, offline sync and exchange replacements.
 * All money math lives in @/lib/commerce; this file persists documents inside a
 * MongoDB transaction so a sale and its side effects are atomic.
 */

export type CompleteSaleInput = {
  branchId: string | null;
  customerId: string | null;
  cashierId: string;
  /** Each line carries its own price tier; omitted lines use the sale tier. */
  items: Array<{ productId: string; quantity: number; unitDiscount: number; pricingMode?: SalePricingMode }>;
  /** Goods bought in the market — priced server-side, never touch stock. */
  directItems?: DirectItemInput[];
  discount: number;
  discountType: "amount" | "percent";
  payments: PaymentInput[];
  /**
   * Responsible employee/department. The API sets these from the cashier's
   * active department; exchange replacements inherit the original sale's
   * attribution so an exchange never silently moves revenue to another team.
   */
  employeeId?: string | null;
  departmentId?: string | null;
  departmentName?: string | null;
  note: string;
  status?: "completed" | "held";
  /** Retail (default) or wholesale catalog prices. */
  pricingMode?: SalePricingMode;
  /** Set by the API only when the caller holds `sales.wholesale`. */
  wholesaleAuthorized?: boolean;
  /** Whether the customer's earned reward credit is granted (defaults to yes). */
  grantBonus?: boolean;
  /**
   * Employee purchase: the sale is attributed to a staff member and the shop
   * applies its employer-funded benefit. The setter must hold
   * `employee_purchases.apply_benefit` (enforced by the API).
   */
  employeePurchase?: { employeeId: string } | null;
  /** Set by the API only when the caller may apply the employee benefit. */
  employeeBenefitAuthorized?: boolean;
  /**
   * Set by the API only when the caller holds `sales.override_expired`.
   * Every use is recorded in the audit log by the caller.
   */
  allowExpired?: boolean;
  /** Client-generated idempotency key (offline sync) — stored on the sale. */
  clientTransactionId?: string | null;
  /** Device that captured the sale offline — stored for traceability. */
  deviceId?: string | null;
  /** Exchange metadata (internal; never accepted from a client payload). */
  originalSaleId?: string | null;
  exchangeReturnId?: string | null;
};

export type CompleteSaleResult = {
  id: string;
  invoiceNumber: string;
  total: number;
  paidAmount: number;
  changeAmount: number;
  status: string;
  creditUsed: number;
  bonusEarned: number;
  bonusRedeemed: number;
  bonusBalance?: number;
  /** Employee purchase details when the sale was made for a staff member. */
  employeePurchase?: {
    employeeId: string;
    employeeName: string;
    benefitPercent: number;
    benefitAmount: number;
    netAmount: number;
    outstanding: number;
  } | null;
  pricingMode: SalePricingMode;
  /** True when expired stock was sold under an authorised override. */
  expiredOverride: boolean;
  /** Lines priced at the wholesale tier in this sale. */
  wholesaleLines: number;
  /** Whether the earned reward credit was granted. */
  bonusGranted: boolean;
};

export class SaleValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
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

type PreparedTotals = {
  items: Array<(PricingItemResult & {
    itemType: "inventory";
    purchaseSource: PurchaseSource | null;
    /** Department of the sold product, snapshotted for the department report. */
    departmentId: string | null;
    departmentName: string;
  }) | {
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
    pricingMode: "retail";
  }>;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
};

export type PreparedEmployeePurchase = {
  employeeId: string;
  employeeName: string;
  departmentId: string | null;
  departmentName: string;
  benefitMode: "percent" | "fixed";
  benefitPercent: number;
  benefitAmount: number;
  /** Employee-owed amount after the benefit. */
  netAmount: number;
};

export type PreparedSale = {
  input: CompleteSaleInput;
  status: "completed" | "held";
  pricingMode: SalePricingMode;
  employeePurchase: PreparedEmployeePurchase | null;
  bonusExpiryDays: number;
  bonusPolicyEnabled: boolean;
  totals: PreparedTotals;
  products: LeanProduct[];
  batchMap: Awaited<ReturnType<typeof getProductBatches>>;
  paymentFields: ReturnType<typeof computeSalePaymentFields> | null;
  cashPortion: number;
  registerId: mongoose.Types.ObjectId | null;
  creditUsed: number;
  bonusRedeemed: number;
  bonusEarned: number;
  bonusEarnBase: number;
  bonusPercent: number;
  expiredOverride: boolean;
  /** Number of lines priced at the wholesale tier. */
  wholesaleLines: number;
  customerBonusBalance: number;
};

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
              { $in: ["$movementType", ["PURCHASE_IN", "CUSTOMER_RETURN_IN", "ADJUSTMENT_IN", "STOCK_COUNT_IN", "TRANSFER_IN"]] },
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

const OUT_TYPES = ["PURCHASE_IN", "CUSTOMER_RETURN_IN", "ADJUSTMENT_IN", "STOCK_COUNT_IN", "TRANSFER_IN"] as const;

/**
 * Server-side pricing + validation of a sale. Used by both normal checkout and
 * exchange replacements, so both paths share exactly the same price rules.
 */
export async function prepareSale(
  input: CompleteSaleInput,
  session: mongoose.ClientSession
): Promise<PreparedSale> {
  const pricingMode: SalePricingMode = input.pricingMode ?? "retail";
  // Pricing is per line: one item can be sold wholesale while the rest stays
  // retail. Any wholesale line still requires the wholesale permission.
  const wholesaleLines = input.items.filter((item) => (item.pricingMode ?? pricingMode) === "wholesale").length;
  if (wholesaleLines > 0 && !input.wholesaleAuthorized) {
    throw new SaleValidationError("WHOLESALE_FORBIDDEN", "You do not have permission to apply wholesale pricing");
  }

  // 1. Fetch and verify products server-side
  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const products = await Product.find({ _id: { $in: productIds }, status: "active" }).session(session).lean();
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  // Each sold line snapshots its product's department, so the department report
  // can credit the department that actually owns the product.
  const departmentIds = [
    ...new Set(products.map((p) => (p.departmentId ? String(p.departmentId) : "")).filter(Boolean)),
  ];
  const departmentNames = new Map<string, string>();
  if (departmentIds.length > 0) {
    const rows = await Department.find({ _id: { $in: departmentIds } })
      .select("name")
      .session(session)
      .lean();
    for (const row of rows) departmentNames.set(String(row._id), row.name);
  }

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
  const batchMap = await getProductBatches(productIds, branchIdOrNull(input.branchId), session);
  let expiredOverrideUsed = false;
  for (const item of input.items) {
    const available = stockMap.get(item.productId) ?? 0;
    const product = productMap.get(item.productId)!;
    if (available < item.quantity) {
      throw new SaleValidationError(
        "INSUFFICIENT_STOCK",
        `Insufficient stock for ${product.name} (${available} available)`
      );
    }
    // Expired batches are still counted in stock (they are never deleted),
    // but they cannot be sold unless an authorised user overrides it.
    const batches = batchMap.get(item.productId) ?? [];
    const expiredQty = expiredQuantity(batches);
    if (expiredQty > 0) {
      const sellable = sellableQuantity(batches);
      const wouldUseExpired = item.quantity > sellable;
      if (wouldUseExpired && !input.allowExpired) {
        throw new SaleValidationError(
          "EXPIRED_PRODUCT",
          `${product.name} has expired stock (${expiredQty} unit${expiredQty === 1 ? "" : "s"}). A manager override is required to sell it.`
        );
      }
      if (wouldUseExpired) expiredOverrideUsed = true;
    }
  }

  // 3. Server recalculates every total — client values are ignored
  const pricingInputs = input.items.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
    unitDiscount: item.unitDiscount,
  }));
  let inventoryTotals: ReturnType<typeof computeSaleTotals>;
  try {
    // Inventory lines are priced at zero sale-level discount first so the
    // sale discount can be applied to the combined (inventory + direct) base.
    // Lines are grouped by their own tier, then merged back into one sale.
    const modeByProduct = new Map(
      input.items.map((item) => [item.productId, item.pricingMode ?? pricingMode] as const)
    );
    const linesByMode = new Map<SalePricingMode, typeof pricingInputs>();
    for (const line of pricingInputs) {
      const mode = modeByProduct.get(line.productId) ?? pricingMode;
      linesByMode.set(mode, [...(linesByMode.get(mode) ?? []), line]);
    }

    const pricedItems: PricingItemResult[] = [];
    let combinedSubtotal = 0;
    let combinedLineDiscounts = 0;
    let combinedTax = 0;
    for (const [mode, lines] of linesByMode) {
      const part = computeSaleTotals(lines, serverProductAdapter(products), 0, input.discountType, mode);
      pricedItems.push(...part.items);
      combinedSubtotal = round2(combinedSubtotal + part.subtotal);
      combinedLineDiscounts = round2(combinedLineDiscounts + part.discount);
      combinedTax = round2(combinedTax + part.tax);
    }
    inventoryTotals = {
      items: pricedItems,
      subtotal: combinedSubtotal,
      discount: combinedLineDiscounts,
      tax: combinedTax,
      total: round2(combinedSubtotal - combinedLineDiscounts + combinedTax),
    };
  } catch (err) {
    if (err instanceof WholesalePriceUnavailableError) {
      throw new SaleValidationError(
        "WHOLESALE_PRICE_UNAVAILABLE",
        `${err.productName} has no wholesale price configured. Disable wholesale pricing or set its wholesale price.`
      );
    }
    throw err;
  }

  const directItems = input.directItems ?? [];
  const directTotals = computeDirectItemTotals(directItems);

  const combinedSubtotal = round2(inventoryTotals.subtotal + directTotals.subtotal);
  const combinedTax = round2(inventoryTotals.tax + directTotals.tax);
  const effectiveBase = round2(combinedSubtotal - inventoryTotals.discount);
  const saleDiscountAmount =
    input.discountType === "percent"
      ? round2((effectiveBase * Math.min(input.discount, 100)) / 100)
      : round2(Math.min(input.discount, effectiveBase));
  const discountAmount = round2(saleDiscountAmount + inventoryTotals.discount);

  const saleItems: PreparedTotals["items"] = [
    ...inventoryTotals.items.map((item) => {
      // Preserve purchase origin on the sold line. A line that mixes Import and
      // Local units is marked null (unknown) — the per-batch movement rows below
      // still record the exact origin of every unit.
      const batches = batchMap.get(item.productId) ?? [];
      const allocations = allocateQuantity(batches, item.quantity, {
        allowExpired: input.allowExpired === true,
      });
      const sources = new Set(allocations.map((a) => a.purchaseSource ?? null));
      // Mixed batches stay unknown; batches without an origin fall back to the
      // origin recorded on the product itself.
      const purchaseSource =
        sources.size === 1
          ? (sources.values().next().value ?? null)
          : sources.size === 0
            ? (productMap.get(item.productId) as { purchaseSource?: PurchaseSource | null } | undefined)
                ?.purchaseSource ?? null
            : null;
      const product = productMap.get(item.productId);
      const departmentId = product?.departmentId ? String(product.departmentId) : null;
      return {
        ...item,
        itemType: "inventory" as const,
        purchaseSource,
        departmentId,
        departmentName: departmentId ? departmentNames.get(departmentId) ?? "" : "",
      };
    }),
    ...directTotals.items,
  ];
  const status = input.status ?? "completed";

  // Employee purchase benefit (employer-funded discount). Computed before the
  // final total so every downstream rule — payments, change, receipts — sees
  // the amount the employee actually owes.
  let preparedEmployee: PreparedEmployeePurchase | null = null;
  let employeeBenefitAmount = 0;
  if (status === "completed" && input.employeePurchase?.employeeId) {
    if (input.customerId) {
      throw new SaleValidationError(
        "EMPLOYEE_PURCHASE_NO_CUSTOMER",
        "An employee purchase is personal — remove the selected customer first"
      );
    }
    if (!input.employeeBenefitAuthorized) {
      throw new SaleValidationError(
        "EMPLOYEE_BENEFIT_FORBIDDEN",
        "You do not have permission to process employee purchases"
      );
    }
    const policy = await getEmployeeBenefitPolicy(input.branchId);
    if (!policy.enabled) {
      throw new SaleValidationError("EMPLOYEE_PURCHASE_DISABLED", "Employee purchases are disabled in settings");
    }

    const employee = await User.findById(input.employeePurchase.employeeId)
      .select("name status branchId purchaseBenefitPercent")
      .session(session)
      .lean();
    if (!employee || employee.status !== "active") {
      throw new SaleValidationError("EMPLOYEE_NOT_FOUND", "Selected employee not found or inactive");
    }
    if (input.branchId && employee.branchId && String(employee.branchId) !== input.branchId) {
      throw new SaleValidationError("EMPLOYEE_WRONG_BRANCH", "The employee does not work in this shop");
    }

    const department = input.branchId
      ? await Department.findOne({
          branchId: new mongoose.Types.ObjectId(input.branchId),
          employeeId: employee._id,
          status: "active",
        })
          .select("name purchaseBenefitPercent")
          .session(session)
          .lean()
      : null;

    const benefitLines: BonusLineForEligibility[] = saleItems.map((item) => ({
      subtotal: item.subtotal,
      discount: item.discount,
      itemType: item.itemType,
      pricingMode: item.pricingMode,
      categoryId:
        item.itemType === "inventory" && item.productId
          ? (String((productMap.get(item.productId) as { categoryId?: unknown } | undefined)?.categoryId ?? "") || null)
          : null,
    }));

    const benefit = computeEmployeeBenefit({
      employeePercent: employee.purchaseBenefitPercent,
      departmentPercent: department?.purchaseBenefitPercent ?? null,
      lines: benefitLines,
      policy,
    });
    employeeBenefitAmount = round2(benefit.benefit);

    preparedEmployee = {
      employeeId: employee._id.toString(),
      employeeName: employee.name,
      departmentId: department ? department._id.toString() : null,
      departmentName: department?.name ?? "",
      benefitMode: benefit.mode,
      benefitPercent: benefit.percent,
      benefitAmount: employeeBenefitAmount,
      netAmount: 0, // filled below, once the sale total is final
    };
  }

  const totalBeforeBenefit = round2(combinedSubtotal - discountAmount + combinedTax);
  const total = round2(Math.max(0, totalBeforeBenefit - employeeBenefitAmount));
  if (preparedEmployee) {
    preparedEmployee.netAmount = total;
    const monthTotal = input.employeePurchase
      ? await employeeMonthlyPurchaseTotal(input.employeePurchase.employeeId, periodOf(new Date()))
      : 0;
    const limitError = checkEmployeeMonthlyLimit({
      policy: await getEmployeeBenefitPolicy(input.branchId),
      alreadyBoughtThisMonth: monthTotal,
      newNetAmount: total,
    });
    if (limitError) throw new SaleValidationError("EMPLOYEE_MONTHLY_LIMIT", limitError);
  }

  const totals: PreparedTotals = {
    items: saleItems,
    subtotal: combinedSubtotal,
    // The stored discount includes the employer-funded employee benefit so
    // total === subtotal − discount + tax always holds.
    discount: round2(discountAmount + employeeBenefitAmount),
    tax: combinedTax,
    total,
  };

  // Selling location check: a warehouse holds stock but is never a register.
  if (input.branchId) {
    const branch = await Branch.findById(input.branchId).select("type status").session(session).lean();
    if (branch && (branch.type ?? "shop") === "warehouse") {
      throw new SaleValidationError(
        "INVALID_SELLING_LOCATION",
        "This location is a warehouse. Sales must be made from a shop."
      );
    }
  }

  // 4. Customer eligibility (wholesale) and reward configuration
  let customer: {
    _id: mongoose.Types.ObjectId;
    name: string;
    wholesaleEligible: boolean;
    bonusPercent: number;
    bonusBalance: number;
    status: string;
  } | null = null;
  if (input.customerId) {
    customer = await Customer.findById(input.customerId)
      .select("name status wholesaleEligible bonusPercent bonusBalance")
      .session(session)
      .lean();
    if (!customer || customer.status !== "active") {
      throw new SaleValidationError("CUSTOMER_NOT_FOUND", "Selected customer not found or inactive");
    }
    if (wholesaleLines > 0 && !customer.wholesaleEligible) {
      throw new SaleValidationError(
        "CUSTOMER_NOT_WHOLESALE_ELIGIBLE",
        "The selected customer is not eligible for wholesale pricing"
      );
    }
  }

  const settings = await getStoreSettings(input.branchId);

  // 5. Validate payments against the server total
  let paymentFields: ReturnType<typeof computeSalePaymentFields> | null = null;
  let creditUsed = 0;
  let bonusRedeemed = 0;
  let bonusEarned = 0;
  let bonusEarnBase = 0;

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

    if (preparedEmployee) {
      const illegal = input.payments.find((p) => p.method === "credit" || p.method === "bonus");
      if (illegal) {
        throw new SaleValidationError(
          "EMPLOYEE_PAYMENT_METHOD",
          "Employee purchases are paid with cash, card or transfer — the unpaid remainder is charged to the employee's account"
        );
      }
    }

    const bonusPayments = input.payments.filter((p) => p.method === "bonus");
    bonusRedeemed = round2(bonusPayments.reduce((s, p) => s + p.amount, 0));

    const bonusPolicy = {
      ...DEFAULT_CUSTOMER_BONUS_POLICY,
      enabled: settings.customerBonusEnabled,
      defaultPercent: settings.customerBonusDefaultPercent,
      minPurchaseAmount: settings.bonusMinPurchaseAmount,
      minRedeemBalance: settings.bonusMinRedeemBalance,
      eligiblePaymentMethods: normalizeMethods(settings.bonusEligiblePaymentMethods),
      wholesaleQualifies: settings.bonusWholesaleQualifies,
      directQualifies: settings.bonusDirectQualifies,
      excludedCategoryIds: parseCsv(settings.bonusExcludedCategoryIds),
      expiryDays: settings.bonusExpiryDays,
      sameTransactionRedeem: settings.bonusSameTransactionRedeem,
      restoreRedeemedOnRefund: settings.bonusRestoreRedeemedOnRefund,
    };

    const bonusLines: BonusLineForEligibility[] = saleItems.map((item) => ({
      subtotal: item.subtotal,
      discount: item.discount,
      itemType: item.itemType,
      pricingMode: item.pricingMode,
      categoryId:
        item.itemType === "inventory" && item.productId
          ? (String((productMap.get(item.productId) as unknown as { categoryId?: unknown })?.categoryId ?? "") || null)
          : null,
    }));

    // Earning is evaluated first: when the shop allows same-transaction
    // redemption, the credit this sale creates is spendable on this sale.
    if (customer && input.grantBonus !== false) {
      const earn = computeCustomerBonus({
        customerBonusPercent: customer.bonusPercent,
        lines: bonusLines,
        saleTotal: totals.total,
        paymentMethods: input.payments.filter((p) => p.method !== "bonus").map((p) => p.method),
        policy: bonusPolicy,
      });
      bonusEarnBase = earn.eligibleBase;
      bonusEarned = earn.earned;
      // Keep the configured basis: "amount_paid" earns only on money actually
      // collected, excluding bonus tendered.
      if (settings.bonusEarnBasis === "amount_paid" && earn.earned > 0) {
        bonusEarnBase = computeBonusEarnBase({
          subtotal: totals.subtotal,
          discount: totals.discount,
          total: totals.total,
          bonusRedeemed,
          basis: settings.bonusEarnBasis,
        });
        bonusEarned = computeBonusEarned(bonusEarnBase, earn.percent);
      }
    }

    if (bonusRedeemed > 0) {
      if (!input.customerId || !customer) {
        throw new SaleValidationError("BONUS_REQUIRES_CUSTOMER", "Reward credit requires a selected customer");
      }
      if (!settings.bonusRedemptionEnabled) {
        throw new SaleValidationError("BONUS_REDEMPTION_DISABLED", "Reward credit redemption is disabled");
      }
      const limit = computeBonusRedemptionLimit({
        enabled: settings.bonusRedemptionEnabled,
        balance: customer.bonusBalance,
        saleTotal: totals.total,
        maxPercent: settings.bonusMaxRedeemPercent,
        minRedeemBalance: settings.bonusMinRedeemBalance,
        earnedThisSale: bonusEarned,
        policy: bonusPolicy,
      });
      if (bonusRedeemed > limit.max + 0.001) {
        throw new SaleValidationError(
          "BONUS_LIMIT_EXCEEDED",
          limit.reason
            ? `${limit.reason}. Maximum redeemable on this sale: ${round2(limit.max)}`
            : `Reward credit cannot cover more than ${settings.bonusMaxRedeemPercent}% of this sale (max ${round2(limit.max)})`
        );
      }
    }

    const validation = validatePaymentsServer(input.payments, totals.total, {
      allowUnderpayment: Boolean(preparedEmployee),
    });
    if (!validation.ok) throw new SaleValidationError("INVALID_PAYMENT", validation.error);

    const employeeOutstanding = preparedEmployee
      ? round2(
          totals.total -
            round2(input.payments.reduce((s, p) => s + p.amount, 0))
        )
      : 0;
    if (preparedEmployee && employeeOutstanding > 0.001) {
      const policy = await getEmployeeBenefitPolicy(input.branchId);
      if (!policy.creditAllowed || policy.deductionMode === "immediate") {
        throw new SaleValidationError(
          "EMPLOYEE_PAYMENT_REQUIRED",
          "This shop requires employee purchases to be paid in full at the till (no salary credit)"
        );
      }
    }

    paymentFields = computeSalePaymentFields(input.payments, totals.total);
  }

  // 6. Every cash sale must link to the cashier's active register.
  // Non-cash sales only attach when a register happens to be open.
  const cashPortion = round2(
    input.payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0)
  );
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
  }

  return {
    input,
    status,
    pricingMode,
    employeePurchase: preparedEmployee,
    bonusExpiryDays: settings.bonusExpiryDays,
    bonusPolicyEnabled: settings.customerBonusEnabled,
    totals,
    products,
    batchMap,
    paymentFields,
    cashPortion,
    registerId,
    creditUsed,
    bonusRedeemed,
    bonusEarned,
    bonusEarnBase,
    bonusPercent: customer?.bonusPercent ?? 0,
    expiredOverride: expiredOverrideUsed,
    wholesaleLines,
    customerBonusBalance: customer?.bonusBalance ?? 0,
  };
}

/**
 * Persists a prepared sale and all of its side effects inside the caller's
 * transaction. Shared by the normal POS flow and exchange replacements.
 */
export async function persistPreparedSale(
  prepared: PreparedSale,
  session: mongoose.ClientSession,
  extra?: {
    originalSaleId?: string | null;
    exchangeReturnId?: string | null;
  }
) {
  const { input, totals, status, paymentFields, pricingMode } = prepared;
  const invoiceNumber = await generateDocumentNumber("INV", session);

  // Department attribution is snapshotted, never recomputed on read: renaming a
  // department or reassigning its head later must not rewrite history.
  const employeeId = input.employeeId ?? input.cashierId;
  let departmentId: string | null = input.departmentId ?? null;
  let departmentName = input.departmentName ?? "";

  // A product belongs to a department, so selling it attributes the sale to
  // that department. Each line already carries its own department snapshot;
  // the sale-level field still records the dominant one for legacy consumers.
  // Products without a department fall back to the cashier's own below.
  if (!departmentId) {
    const productIds = totals.items
      .filter((item) => item.productId)
      .map((item) => new mongoose.Types.ObjectId(item.productId as unknown as string));
    if (productIds.length > 0) {
      const owning = await Product.find({ _id: { $in: productIds }, departmentId: { $ne: null } })
        .select("departmentId")
        .session(session)
        .lean();
      const departmentByProduct = new Map<string, string>();
      for (const row of owning) departmentByProduct.set(String(row._id), String(row.departmentId));

      const weights = new Map<string, number>();
      for (const item of totals.items) {
        const productDepartment = item.productId
          ? departmentByProduct.get(String(item.productId))
          : undefined;
        if (!productDepartment) continue;
        weights.set(productDepartment, (weights.get(productDepartment) ?? 0) + item.subtotal);
      }
      const dominant = [...weights.entries()].sort((a, b) => b[1] - a[1])[0];
      if (dominant) {
        const department = await Department.findById(dominant[0])
          .select("name")
          .session(session)
          .lean();
        if (department) {
          departmentId = String(department._id);
          departmentName = department.name;
        }
      }
    }
  }

  if (!departmentId && input.branchId) {
    const department = await Department.findOne({
      branchId: input.branchId,
      employeeId,
      status: "active",
    })
      .select("name")
      .session(session)
      .lean();
    if (department) {
      departmentId = department._id.toString();
      departmentName = department.name;
    }
  }

  const saleDocs = await Sale.create(
    [
      {
        invoiceNumber,
        clientTransactionId: input.clientTransactionId ?? null,
        deviceId: input.deviceId ?? null,
        branchId: input.branchId,
        registerId: prepared.registerId,
        customerId: input.customerId,
        cashierId: input.cashierId,
        employeeId,
        departmentId,
        departmentName,
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
        pricingMode,
        bonusPercent: prepared.bonusPercent,
        bonusEarned: prepared.bonusEarned,
        bonusRedeemed: prepared.bonusRedeemed,
        bonusEarnBase: prepared.bonusEarnBase,
        bonusGranted: input.grantBonus !== false,
        originalSaleId: extra?.originalSaleId ?? input.originalSaleId ?? null,
        exchangeReturnId: extra?.exchangeReturnId ?? input.exchangeReturnId ?? null,
        heldAt: status === "held" ? new Date() : null,
        heldBy: status === "held" ? input.cashierId : null,
        note: input.note.slice(0, 500),
      },
    ],
    { session }
  );
  const sale = saleDocs[0];

  // Inventory movements (sale out) — direct-sale lines have no productId
  // and never touch the stock ledger. Batched stock is consumed FEFO so the
  // per-batch quantities (and therefore expiry alerts) stay accurate.
  if (status === "completed") {
    const movementDocs: Array<Record<string, unknown>> = [];
    for (const item of totals.items) {
      if (item.itemType !== "inventory" || !item.productId) continue;
      const batches = prepared.batchMap.get(item.productId) ?? [];
      const allocations = allocateQuantity(batches, item.quantity, {
        allowExpired: input.allowExpired === true,
      });
      const lines =
        allocations.length > 0
          ? allocations
          : [{ batchNumber: "", expirationDate: null, quantity: item.quantity }];
      for (const line of lines) {
        movementDocs.push({
          productId: new mongoose.Types.ObjectId(item.productId),
          branchId: input.branchId ? new mongoose.Types.ObjectId(input.branchId) : null,
          movementType: "SALE_OUT",
          quantity: line.quantity,
          unitCost: item.costPrice,
          batchNumber: line.batchNumber,
          expirationDate: line.expirationDate,
          purchaseSource: line.purchaseSource ?? null,
          referenceType: "sale",
          referenceId: sale._id,
          note: `Sale ${invoiceNumber}${line.batchNumber ? ` (batch ${line.batchNumber})` : ""}`,
          userId: new mongoose.Types.ObjectId(input.cashierId),
        });
      }
    }
    if (movementDocs.length > 0) {
      await InventoryMovement.insertMany(movementDocs, { session });
    }

    // Customer ledger entry for the credit portion
    if (prepared.creditUsed > 0 && input.customerId) {
      await appendLedgerEntry(
        {
          customerId: input.customerId,
          branchId: input.branchId,
          type: "SALE",
          amount: prepared.creditUsed,
          referenceType: "sale",
          referenceId: sale._id.toString(),
          description: `Credit sale ${invoiceNumber}`,
          userId: input.cashierId,
        },
        session
      );
    }

    // Reward credit: redemption first, then earning. Both are idempotent.
    if (input.customerId) {
      if (prepared.bonusRedeemed > 0) {
        await appendBonusEntry(
          {
            customerId: input.customerId,
            branchId: input.branchId,
            type: "REDEEM",
            amount: -prepared.bonusRedeemed,
            referenceType: "sale",
            referenceId: sale._id.toString(),
            description: `Reward credit redeemed on ${invoiceNumber}`,
            userId: input.cashierId,
            idempotencyKey: `sale:${sale._id.toString()}:redeem`,
          },
          session
        );
      }
      if (prepared.bonusEarned > 0) {
        await appendBonusEntry(
          {
            customerId: input.customerId,
            branchId: input.branchId,
            type: "EARN",
            amount: prepared.bonusEarned,
            referenceType: "sale",
            referenceId: sale._id.toString(),
            description: `Reward credit earned on ${invoiceNumber}`,
            expiresAt: bonusExpiryDate(new Date(), prepared.bonusExpiryDays),
            userId: input.cashierId,
            idempotencyKey: `sale:${sale._id.toString()}:earn`,
          },
          session
        );
      }
    }

    // Employee purchase: the sale is the source of truth, this row tracks the
    // benefit granted and what the employee still owes.
    if (prepared.employeePurchase) {
      const paid = round2(
        (paymentFields?.paymentLines ?? []).reduce((s, p) => s + (p.method === "cash" || p.method === "card" || p.method === "transfer" ? p.amount : 0), 0)
      );
      await createEmployeePurchaseForSale(
        {
          saleId: sale._id.toString(),
          invoiceNumber,
          branchId: input.branchId ?? "",
          employeeId: prepared.employeePurchase.employeeId,
          employeeName: prepared.employeePurchase.employeeName,
          departmentId: prepared.employeePurchase.departmentId,
          departmentName: prepared.employeePurchase.departmentName,
          cashierId: input.cashierId,
          benefitMode: prepared.employeePurchase.benefitMode,
          benefitPercent: prepared.employeePurchase.benefitPercent,
          benefitAmount: prepared.employeePurchase.benefitAmount,
          netAmount: prepared.employeePurchase.netAmount,
          paidAmount: paid,
        },
        session
      );
    }

    // Cash drawer movement — net cash the drawer should physically hold for
    // this sale (cash received minus change handed back).
    if (prepared.registerId && prepared.cashPortion > 0) {
      const cashIn = round2(prepared.cashPortion - (paymentFields?.changeAmount ?? 0));
      if (cashIn !== 0) {
        await addCashTransaction(
          {
            registerId: prepared.registerId.toString(),
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

  return { sale, invoiceNumber };
}

export async function completeSale(input: CompleteSaleInput): Promise<CompleteSaleResult> {
  await connectDB();

  // Write off any earned bonus whose expiry has passed before the cashier sees
  // or spends the balance. Idempotent per earning row.
  if (input.customerId) {
    try {
      await expireCustomerBonus(input.customerId, input.cashierId);
    } catch (err) {
      console.error("[bonus] expiry sweep failed", err);
    }
  }

  const session = await mongoose.startSession();
  let result: CompleteSaleResult;

  try {
    await session.withTransaction(async () => {
      const prepared = await prepareSale(input, session);
      const { sale, invoiceNumber } = await persistPreparedSale(prepared, session);

      result = {
        id: sale._id.toString(),
        invoiceNumber,
        total: prepared.totals.total,
        paidAmount: prepared.paymentFields?.paidAmount ?? 0,
        changeAmount: prepared.paymentFields?.changeAmount ?? 0,
        status: prepared.status,
        creditUsed: prepared.creditUsed,
        bonusEarned: prepared.bonusEarned,
        bonusRedeemed: prepared.bonusRedeemed,
        bonusBalance: round2(prepared.customerBonusBalance - prepared.bonusRedeemed + prepared.bonusEarned),
        employeePurchase: prepared.employeePurchase
          ? {
              employeeId: prepared.employeePurchase.employeeId,
              employeeName: prepared.employeePurchase.employeeName,
              benefitPercent: prepared.employeePurchase.benefitPercent,
              benefitAmount: prepared.employeePurchase.benefitAmount,
              netAmount: prepared.employeePurchase.netAmount,
              outstanding: round2(
                prepared.employeePurchase.netAmount -
                  (prepared.paymentFields?.paymentLines ?? [])
                    .filter((p) => p.method === "cash" || p.method === "card" || p.method === "transfer")
                    .reduce((s, p) => s + p.amount, 0)
              ),
            }
          : null,
        pricingMode: prepared.pricingMode,
        expiredOverride: prepared.expiredOverride,
        wholesaleLines: prepared.wholesaleLines,
        bonusGranted: input.grantBonus !== false,
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

function serverProductAdapter(products: LeanProduct[]) {
  return products.map((p) => ({
    _id: p._id.toString(),
    name: p.name,
    sku: p.sku,
    costPrice: p.costPrice,
    sellingPrice: p.sellingPrice,
    // `discountPrice` is the persisted wholesale price field.
    wholesalePrice: p.discountPrice,
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
  total: number,
  options: { allowUnderpayment?: boolean } = {}
): { ok: true } | { ok: false; error: string } {
  if (!payments || payments.length === 0) {
    // An employee purchase may be settled entirely from salary later, so no
    // tender at all is a valid sale when underpayment is allowed.
    return options.allowUnderpayment
      ? { ok: true }
      : { ok: false, error: "At least one payment is required" };
  }

  let nonCash = 0;
  let cash = 0;
  let credit = 0;

  for (const p of payments) {
    if (!["cash", "card", "transfer", "credit", "bonus", "exchange"].includes(p.method)) {
      return { ok: false, error: `Invalid payment method: ${p.method}` };
    }
    if (!Number.isFinite(p.amount) || p.amount < 0) {
      return { ok: false, error: "Payment amounts cannot be negative" };
    }
    if (p.amount === 0) continue;
    if (p.method === "cash") cash = round2(cash + p.amount);
    else if (p.method === "credit") credit = round2(credit + p.amount);
    else nonCash = round2(nonCash + p.amount);
  }

  if (nonCash > total + 0.001) {
    return { ok: false, error: "Non-cash payments exceed the total. Only cash can produce change." };
  }

  if (credit > 0) {
    // Credit covers part/all of the total and creates customer debt; the covered
    // portion (cash + non-cash + bonus + exchange) plus credit must equal total.
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
    return { ok: true };
  }

  // Employee purchases may leave a balance on the employee's account, which
  // payroll recovers; every other sale must be covered at the till.
  if (!options.allowUnderpayment && round2(cash + nonCash) < total - 0.001) {
    return { ok: false, error: "Total paid does not cover the sale total" };
  }
  if (options.allowUnderpayment && round2(cash + nonCash) > total + 0.001) {
    return { ok: false, error: "Payments exceed the sale total" };
  }

  return { ok: true };
}

export type { ISalePayment, PaymentMethod as SalePaymentMethod };
export { SaleReturn };
