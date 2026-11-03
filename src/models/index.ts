import mongoose, { Schema, Document, Model } from "mongoose";
import { syncTrackingPlugin } from "@/lib/sync/tracking";

export type BaseDocument = {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type IRoleDocument = Document & {
  name: string;
  description: string;
  isSystem: boolean;
  permissions: mongoose.Types.ObjectId[];
};

export type IPermissionDocument = Document & {
  name: string;
  description: string;
  category: string;
};

export type IUserDocument = Document & {
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
  roleId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId | null;
  status: "active" | "inactive" | "pending";
  /** Employee purchase benefit override (null = department or shop default). */
  purchaseBenefitPercent: number | null;
  /** Outstanding employee-purchase balance recovered from future salary. */
  purchaseOutstanding: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  refreshTokenHash: string | null;
  passwordResetTokenHash: string | null;
  passwordResetExpires: Date | null;
};

/** A branch is either a selling shop or a warehouse (stock location). */
export type BranchType = "shop" | "warehouse";

export type IBranchDocument = Document & {
  name: string;
  code: string;
  address: string;
  phone: string;
  timezone: string;
  currency: string;
  status: "active" | "inactive";
  /** Selling locations are shops; warehouses hold stock and never sell. */
  type: BranchType;
  taxRate: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A warehouse is a stock location in its own right — not a branch. It holds no
 * register, no staff assignment and never sells; its stock only moves in and
 * out through purchases and stock transfers.
 */
export type IWarehouseDocument = Document & {
  name: string;
  code: string;
  address: string;
  phone: string;
  status: "active" | "inactive";
  note: string;
  createdBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Where purchased stock came from. Import stock is manager-controlled. */
export type PurchaseSource = "import" | "local";

export type ICategoryDocument = Document & {
  name: string;
  description: string;
  parentId: mongoose.Types.ObjectId | null;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
};

export type IBrandDocument = Document & {
  name: string;
  description: string;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
};

/**
 * An additional scannable barcode for a product (flavour, packaging variant…).
 * `label` is a human hint shown in the UI (e.g. "Strawberry").
 */
export type IProductBarcode = {
  code: string;
  label: string;
};

export type IProductDocument = Document & {
  name: string;
  sku: string;
  /** Primary barcode — kept for backward compatibility with existing rows. */
  barcode: string;
  /** Extra unique barcodes for the same sellable product. */
  barcodes: IProductBarcode[];
  description: string;
  categoryId: mongoose.Types.ObjectId;
  brandId: mongoose.Types.ObjectId | null;
  /** Department (mini-store) that owns this product; null = the shop itself. */
  departmentId: mongoose.Types.ObjectId | null;
  /** Default origin of this product's stock (null = only batches know). */
  purchaseSource: PurchaseSource | null;
  costPrice: number;
  sellingPrice: number;
  discountPrice: number;
  taxRate: number;
  discount: number;
  reorderPoint: number;
  /** Optional product-level expiry, used when no dated purchase batch exists. */
  expirationDate: Date | null;
  /** Variants are separate product rows (own price/stock) linked to a parent. */
  parentProductId: mongoose.Types.ObjectId | null;
  variantName: string;
  status: "active" | "inactive" | "archived";
  branchId: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InventoryMovementType =
  | "PURCHASE_IN"
  | "SALE_OUT"
  | "CUSTOMER_RETURN_IN"
  | "SUPPLIER_RETURN_OUT"
  | "ADJUSTMENT_IN"
  | "ADJUSTMENT_OUT"
  | "STOCK_COUNT_IN"
  | "STOCK_COUNT_OUT"
  | "TRANSFER_IN"
  | "TRANSFER_OUT";

export type IInventoryMovementDocument = Document & {
  productId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId | null;
  /** Set when the stock sits in a warehouse instead of a branch. */
  warehouseId: mongoose.Types.ObjectId | null;
  movementType: InventoryMovementType;
  quantity: number;
  unitCost: number;
  /** Received batch this movement belongs to ("" = legacy/unbatched stock). */
  batchNumber: string;
  /** Expiry of the batch this movement belongs to (null = no expiry tracking). */
  expirationDate: Date | null;
  /** Import (China) vs Local origin of the stock this movement carries. */
  purchaseSource: PurchaseSource | null;
  referenceType: "sale" | "purchase" | "adjustment" | "count" | "transfer" | "damage" | "return" | null;
  referenceId: mongoose.Types.ObjectId | null;
  note: string;
  userId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type SaleItemType = "inventory" | "direct";

/** Which catalog price tier was applied to a line at the time of sale. */
export type SalePricingMode = "retail" | "wholesale";

export type ISaleItemSnapshot = {
  /** null for direct-sale items (bought in the market, not stock-managed). */
  productId: mongoose.Types.ObjectId | null;
  /** Inventory items affect stock; direct items never touch the stock ledger. */
  itemType: SaleItemType;
  /** Price tier charged for this line (direct lines use the negotiated price). */
  pricingMode: SalePricingMode;
  name: string;
  sku: string;
  quantity: number;
  sellingPrice: number;
  costPrice: number;
  discount: number;
  tax: number;
  subtotal: number;
  /** Origin of the consumed batch, when it is known (null = unassigned). */
  purchaseSource: PurchaseSource | null;
  /**
   * Department that owns the product on this line, snapshotted when the sale
   * was completed. The department report attributes revenue line by line, so a
   * mixed cart raises every product's own department instead of only one.
   */
  departmentId: mongoose.Types.ObjectId | null;
  departmentName: string;
};

export type ISalePaymentMethod = "cash" | "card" | "transfer" | "credit" | "bonus" | "exchange";

export type ISalePayment = {
  /** `bonus` pays with reward credit; `exchange` is internal credit from a return. */
  method: ISalePaymentMethod;
  amount: number;
  reference: string;
};

export type SaleStatus = "completed" | "canceled" | "held";

export type ISaleDocument = Document & {
  invoiceNumber: string;
  /** Client-generated idempotency key for offline sales (null for normal sales). */
  clientTransactionId: string | null;
  /** Device that captured the sale when it originated offline (null otherwise). */
  deviceId: string | null;
  branchId: mongoose.Types.ObjectId | null;
  customerId: mongoose.Types.ObjectId | null;
  cashierId: mongoose.Types.ObjectId;
  /**
   * Employee the sale is attributed to (snapshot). Normally the cashier; kept
   * separate so historical attribution survives a cashier/department change.
   */
  employeeId: mongoose.Types.ObjectId | null;
  /** Department snapshot at completion (null = unassigned, legacy sales). */
  departmentId: mongoose.Types.ObjectId | null;
  departmentName: string;
  /** Cash register session this sale belongs to (null for non-cash sales without an open drawer). */
  registerId: mongoose.Types.ObjectId | null;
  status: SaleStatus;
  items: ISaleItemSnapshot[];
  subtotal: number;
  discount: number;
  discountType: "amount" | "percent";
  tax: number;
  total: number;
  paidAmount: number;
  changeAmount: number;
  paymentMethod: ISalePaymentMethod | "mixed" | null;
  payments: ISalePayment[];
  /** Whole-sale pricing tier; individual lines snapshot their own mode. */
  pricingMode: SalePricingMode;
  /** Customer's bonus percentage snapshotted when the sale was completed. */
  bonusPercent: number;
  /** Reward credit earned by this sale (never part of revenue). */
  bonusEarned: number;
  /** Reward credit redeemed as a tender on this sale. */
  bonusRedeemed: number;
  /** Merchandise base used to calculate `bonusEarned` (audit trail). */
  bonusEarnBase: number;
  /** Whether the earned reward credit was actually granted (cashier opt-in). */
  bonusGranted: boolean;
  /** Original sale replaced by this exchange sale (null for normal sales). */
  originalSaleId: mongoose.Types.ObjectId | null;
  /** Return document that authorised this exchange sale (null otherwise). */
  exchangeReturnId: mongoose.Types.ObjectId | null;
  heldAt: Date | null;
  heldBy: mongoose.Types.ObjectId | null;
  note: string;
  createdAt: Date;
  updatedAt: Date;
};

export type IPurchaseItemSnapshot = {
  productId: mongoose.Types.ObjectId;
  name: string;
  sku: string;
  quantity: number;
  purchasePrice: number;
  sellingPrice: number;
  costPrice: number;
  discount: number;
  tax: number;
  subtotal: number;
  batchNumber?: string;
  expirationDate?: Date | null;
};

export type IPurchaseDocument = Document & {
  purchaseNumber: string;
  branchId: mongoose.Types.ObjectId;
  supplierId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  /** Import (China) purchases follow manager-only rules; Local is open to buyers. */
  purchaseSource: PurchaseSource;
  /** Department (mini-store) a local purchase was bought for; null = the shop itself. */
  departmentId: mongoose.Types.ObjectId | null;
  departmentName: string;
  status: "draft" | "pending" | "completed" | "canceled";
  items: IPurchaseItemSnapshot[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paidAmount: number;
  dueAmount: number;
  paymentMethod: "cash" | "card" | "transfer" | "check" | "account" | "other";
  note: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ICustomerDocument = Document & {
  name: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
  status: "active" | "inactive";
  /** Only eligible customers may check out with wholesale prices. */
  wholesaleEligible: boolean;
  /** Percentage of eligible merchandise earned as reward credit (0 = disabled). */
  bonusPercent: number;
  /** Persistent reward-credit balance, kept in sync with CustomerBonusTransaction. */
  bonusBalance: number;
  branchId: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CustomerBonusTransactionType = "EARN" | "REDEEM" | "REVERSAL" | "RESTORE" | "EXPIRE" | "ADJUSTMENT";

/**
 * Reward-credit ledger. Separate from CustomerTransaction (debt), payments and
 * revenue: entries are signed bonus units, never money owed by the customer.
 */
export type ICustomerBonusTransactionDocument = Document & {
  customerId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId | null;
  type: CustomerBonusTransactionType;
  /** Signed bonus delta: + earned, − redeemed/reversed. */
  amount: number;
  balanceAfter: number;
  referenceType: "sale" | "sale_return" | "adjustment" | null;
  referenceId: mongoose.Types.ObjectId | null;
  description: string;
  /** When this EARN row stops being spendable (null = never). */
  expiresAt: Date | null;
  /** Cashier, and the manager who approved a manual adjustment. */
  approvedBy: mongoose.Types.ObjectId | null;
  /** Reason is mandatory for manual adjustments. */
  reason: string;
  /** Unique per business event so retries/sync can never double-credit. */
  idempotencyKey: string;
  userId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type ISupplierDocument = Document & {
  name: string;
  email: string;
  phone: string;
  address: string;
  note: string;
  status: "active" | "inactive";
  branchId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type CustomerTransactionType = "SALE" | "PAYMENT" | "REFUND" | "ADJUSTMENT";

export type ICustomerTransactionDocument = Document & {
  customerId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId | null;
  type: CustomerTransactionType;
  /**
   * Signed amount affecting the customer's outstanding balance.
   * Positive increases what the customer owes (credit sale).
   * Negative decreases what the customer owes (payment received, refund).
   */
  amount: number;
  balanceAfter: number;
  /** Payment method for PAYMENT entries (cash, card, transfer, …). */
  method: string;
  /** External reference (receipt #, bank ref, …). */
  reference: string;
  referenceType: "sale" | "sale_return" | "payment" | "adjustment" | null;
  referenceId: mongoose.Types.ObjectId | null;
  description: string;
  userId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type ISupplierTransactionDocument = Document & {
  supplierId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  type: "purchase" | "payment" | "adjustment" | "credit" | "debit";
  amount: number;
  balanceAfter: number;
  method: string;
  reference: string;
  referenceType: "purchase" | "payment" | "adjustment" | "credit" | "debit" | null;
  referenceId: mongoose.Types.ObjectId | null;
  description: string;
  userId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type IPaymentDocument = Document & {
  type: "sale" | "purchase" | "account_receivable" | "account_payable" | "expense" | "other";
  referenceType: "sale" | "purchase" | "customer_transaction" | "supplier_transaction" | "expense" | "cash_register" | null;
  referenceId: mongoose.Types.ObjectId | null;
  amount: number;
  method: "cash" | "card" | "transfer" | "check" | "account" | "other";
  description: string;
  userId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

export const EXPENSE_CATEGORIES = [
  "rent",
  "electricity",
  "internet",
  "salary",
  "transport",
  "maintenance",
  "packaging",
  "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export type IExpenseDocument = Document & {
  branchId: mongoose.Types.ObjectId | null;
  categoryId: mongoose.Types.ObjectId | null;
  /** Operational expense category (rent, electricity, …) — independent of product categories. */
  category: ExpenseCategory;
  userId: mongoose.Types.ObjectId;
  status: "draft" | "pending" | "completed" | "canceled";
  description: string;
  amount: number;
  tax: number;
  total: number;
  paidAmount: number;
  paymentMethod: "cash" | "card" | "transfer" | "check" | "account" | "other";
  reference: string;
  /** Business date of the expense (defaults to creation time). */
  date: Date;
  note: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ICashRegisterDocument = Document & {
  branchId: mongoose.Types.ObjectId | null;
  status: "closed" | "open" | "closing";
  openCash: number;
  expectedCash: number;
  countedCash: number | null;
  difference: number | null;
  openedAt: Date | null;
  closedAt: Date | null;
  openedBy: mongoose.Types.ObjectId | null;
  closedBy: mongoose.Types.ObjectId | null;
  note: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Canonical cash drawer movement types (signed amounts):
 *  opening +, sale +, income +, refund −, expense −, adjustment ±, closing = counted cash (excluded from expected-cash math).
 * Legacy types kept in the enum so historical documents remain valid.
 */
export type CashTransactionType =
  | "opening"
  | "sale"
  | "refund"
  | "expense"
  | "income"
  | "adjustment"
  | "closing"
  | "purchase"
  | "payment_in"
  | "payment_out";

export type CashTransactionReferenceType =
  | "sale"
  | "sale_return"
  | "expense"
  | "customer_payment"
  | "supplier_payment"
  | "income"
  | "adjustment"
  | null;

export type ICashTransactionDocument = Document & {
  registerId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId | null;
  type: CashTransactionType;
  amount: number;
  description: string;
  referenceType: CashTransactionReferenceType;
  referenceId: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ISaleReturnItemSnapshot = {
  /** null for a returned direct-sale line (never restocked). */
  productId: mongoose.Types.ObjectId | null;
  itemType: SaleItemType;
  /** Original sale line this return was taken from. */
  sourceLineId: string;
  /** Whether an inventory line goes back on the shelf. */
  restock: boolean;
  pricingMode: SalePricingMode;
  name: string;
  sku: string;
  quantity: number;
  sellingPrice: number;
  costPrice: number;
  discount: number;
  tax: number;
  subtotal: number;
  /** Department snapshot copied from the returned sale line. */
  departmentId: mongoose.Types.ObjectId | null;
  departmentName: string;
};

export type ISaleReturnDocument = Document & {
  returnNumber: string;
  /** Client-generated idempotency key for POS refunds/exchanges. */
  clientTransactionId: string | null;
  saleId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId | null;
  customerId: mongoose.Types.ObjectId | null;
  userId: mongoose.Types.ObjectId;
  /** Attribution snapshotted from the original sale for department reports. */
  employeeId: mongoose.Types.ObjectId | null;
  departmentId: mongoose.Types.ObjectId | null;
  departmentName: string;
  status: "pending" | "approved" | "rejected";
  items: ISaleReturnItemSnapshot[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  refundMethod: "cash" | "original" | "credit" | "card" | "transfer";
  reason: string;
  note: string;
  /** Replacement sale created in the same exchange (null for plain refunds). */
  exchangeSaleId: mongoose.Types.ObjectId | null;
  replacementTotal: number;
  /** Positive = customer paid the difference; negative = customer was refunded. */
  netAmount: number;
  /** Reward credit reversed proportionally on this return. */
  bonusReversed: number;
  /** Reward credit given back because it was spent on the original sale. */
  bonusRestored: number;
  approvedBy: mongoose.Types.ObjectId | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type IAuditLogDocument = Document & {
  action: string;
  entityType: string;
  entityId: mongoose.Types.ObjectId | null;
  userId: mongoose.Types.ObjectId | null;
  branchId: mongoose.Types.ObjectId | null;
  changes: Record<string, { before?: unknown; after?: unknown }>;
  ip: string | null;
  userAgent: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type IStoreSettingsDocument = Document & {
  branchId: mongoose.Types.ObjectId;
  key: string;
  value: unknown;
  updatedBy: mongoose.Types.ObjectId | null;
  updatedAt: Date;
};

/**
 * Online store product — curated separately from POS `Product` rows.
 * The storefront sells only what an admin explicitly adds here, not the
 * entire retail catalog.
 */
export type IStoreProductDocument = Document & {
  name: string;
  slug: string;
  description: string;
  /** Retail price shown on the storefront. */
  price: number;
  /** Optional "was" price for strike-through discount display (0 = none). */
  compareAtPrice: number;
  /** Stand-in color for the card art when no image is uploaded. */
  accent: string;
  imageUrl: string;
  /** Denormalized category name shown on the storefront (kept in sync with categoryId). */
  category: string;
  /** Link to the real POS category collection (null for legacy free-text rows). */
  categoryId: mongoose.Types.ObjectId | null;
  /** Units available to online buyers (stock is decremented on checkout). */
  stock: number;
  featured: boolean;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
};

export type StoreOrderStatus = "pending" | "confirmed" | "shipped" | "delivered" | "canceled";

export type IStoreOrderItemSnapshot = {
  productId: mongoose.Types.ObjectId;
  name: string;
  price: number;
  quantity: number;
};

/** An order placed through the public storefront (cash/phone-confirmed). */
export type IStoreOrderDocument = Document & {
  orderNumber: string;
  customerName: string;
  phone: string;
  email: string;
  address: string;
  note: string;
  items: IStoreOrderItemSnapshot[];
  subtotal: number;
  total: number;
  status: StoreOrderStatus;
  createdAt: Date;
  updatedAt: Date;
};

/* ---------------------------------------------------------------------------
 * Departments & employees
 *
 * A department belongs to one shop (branch) and is headed by exactly one
 * employee. Historical sales snapshot the department id AND name, so renaming
 * or reassigning a department never rewrites past attribution.
 * ------------------------------------------------------------------------- */

export type IDepartmentDocument = Document & {
  name: string;
  /** Short human code, unique per shop. */
  code: string;
  branchId: mongoose.Types.ObjectId;
  /** Employee heading the department (must be an active user of the branch). */
  employeeId: mongoose.Types.ObjectId;
  /** Employee purchase benefit rate for this department (null = shop default). */
  purchaseBenefitPercent: number | null;
  status: "active" | "inactive";
  note: string;
  createdBy: mongoose.Types.ObjectId | null;
  deactivatedAt: Date | null;
  deactivatedBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

/* ---------------------------------------------------------------------------
 * Attendance & payroll
 *
 * Attendance stores exceptions only: every scheduled working day is present
 * unless a manager records absent/leave/rest/holiday. Payroll months are
 * generated once, then finalized; payment rows are tracked per entry and a
 * unique (user, period, branch) index makes duplicate pay impossible.
 * ------------------------------------------------------------------------- */

export type IEmployeeSalaryDocument = Document & {
  userId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  monthlySalary: number;
  currency: string;
  /** First month the salary applies to (YYYY-MM or a full date). */
  effectiveFrom: Date;
  status: "active" | "inactive";
  note: string;
  createdBy: mongoose.Types.ObjectId | null;
  updatedBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AttendanceStatus = "absent" | "leave" | "rest" | "holiday";

export type IAttendanceRecordDocument = Document & {
  userId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  /** Calendar day as YYYY-MM-DD (unique per employee). */
  dateKey: string;
  date: Date;
  status: AttendanceStatus;
  note: string;
  markedBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PayrollStatus = "draft" | "finalized";

export type IPayrollTotals = {
  employees: number;
  grossSalary: number;
  deductions: number;
  netPayable: number;
  paidAmount: number;
  outstanding: number;
  absentDays: number;
};

export type IPayrollPeriodDocument = Document & {
  branchId: mongoose.Types.ObjectId;
  /** Payroll month as YYYY-MM. */
  period: string;
  status: PayrollStatus;
  totals: IPayrollTotals;
  note: string;
  generatedBy: mongoose.Types.ObjectId | null;
  generatedAt: Date | null;
  finalizedBy: mongoose.Types.ObjectId | null;
  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PayrollEntryStatus = "unpaid" | "partial" | "paid";

export type IPayrollEntryDocument = Document & {
  payrollId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  userName: string;
  period: string;
  monthlySalary: number;
  calendarDays: number;
  scheduledDays: number;
  restDays: number;
  leaveDays: number;
  absentDays: number;
  /** Non-penalty absence allowance applied this month (default 7). */
  allowanceDays: number;
  /** Absence days beyond the allowance — each one costs one day's salary. */
  unpaidAbsenceDays: number;
  dailyRate: number;
  deduction: number;
  netPayable: number;
  paidAmount: number;
  /** Salary withheld this month to recover employee purchases. */
  purchaseDeduction: number;
  status: PayrollEntryStatus;
  lastPaidAt: Date | null;
  note: string;
  createdAt: Date;
  updatedAt: Date;
};

/* ---------------------------------------------------------------------------
 * Employee purchase benefit
 *
 * Employees buy at the normal POS. The shop grants an employer-funded benefit
 * (discount); the amount the employee actually owes is the net amount. Any
 * part not paid at the till stays as `outstandingAmount` and is recovered from
 * salary at the end of the month, at most once per purchase.
 *
 * Every document here is append-only financial history: reversals are new
 * rows, never edits, and each row carries a unique idempotency key so offline
 * retries and cloud synchronization can never post the same event twice.
 * ------------------------------------------------------------------------- */

export type EmployeePurchaseStatus = "open" | "settled" | "deducted" | "canceled" | "refunded";

export type IEmployeePurchaseDocument = Document & {
  purchaseNumber: string;
  branchId: mongoose.Types.ObjectId;
  /** The POS sale that created this purchase (one purchase per sale). */
  saleId: mongoose.Types.ObjectId;
  invoiceNumber: string;
  employeeId: mongoose.Types.ObjectId;
  employeeName: string;
  departmentId: mongoose.Types.ObjectId | null;
  departmentName: string;
  cashierId: mongoose.Types.ObjectId;
  benefitMode: "percent" | "fixed";
  /** Rate snapshotted at purchase time (percent mode). */
  benefitPercent: number;
  /** Merchandise value before the employee benefit. */
  grossAmount: number;
  /** Employer-funded benefit (never salary debt). */
  benefitAmount: number;
  /** What the employee actually owes. */
  netAmount: number;
  paidAmount: number;
  outstandingAmount: number;
  status: EmployeePurchaseStatus;
  /** Payroll month this purchase was (or will be) recovered in. */
  payrollPeriod: string;
  payrollDeductionId: mongoose.Types.ObjectId | null;
  /** Manager decision: keep this purchase out of the next payroll run. */
  payrollExcluded: boolean;
  note: string;
  createdAt: Date;
  updatedAt: Date;
};

export type IEmployeePurchasePaymentDocument = Document & {
  employeePurchaseId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  amount: number;
  method: string;
  reference: string;
  userId: mongoose.Types.ObjectId;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
};

export type EmployeePurchaseDeductionStatus = "pending" | "applied" | "reversed";

export type IEmployeePurchaseDeductionDocument = Document & {
  employeePurchaseId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  payrollId: mongoose.Types.ObjectId;
  payrollEntryId: mongoose.Types.ObjectId;
  period: string;
  amount: number;
  status: EmployeePurchaseDeductionStatus;
  approvedBy: mongoose.Types.ObjectId | null;
  approvedAt: Date | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
};

export type EmployeePurchaseLedgerType =
  | "PURCHASE"
  | "BENEFIT"
  | "PAYMENT"
  | "DEDUCTION"
  | "REFUND"
  | "ADJUSTMENT";

export type IEmployeePurchaseLedgerDocument = Document & {
  employeeId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  employeePurchaseId: mongoose.Types.ObjectId | null;
  type: EmployeePurchaseLedgerType;
  /** Event amount (benefit rows are informational). */
  amount: number;
  /** Signed effect on what the employee owes (+ owes more, − owes less). */
  balanceDelta: number;
  balanceAfter: number;
  referenceType: "sale" | "sale_return" | "payment" | "payroll" | "adjustment" | null;
  referenceId: mongoose.Types.ObjectId | null;
  description: string;
  idempotencyKey: string;
  userId: mongoose.Types.ObjectId;
  approvedBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

/* ---------------------------------------------------------------------------
 * Warehouse → shop stock transfers
 *
 * Stock moves between branches/locations through paired inventory movements.
 * The OUT movement is written on dispatch and the IN movement only when the
 * destination receives the goods, so goods in transit are visible and total
 * stock never increases merely because it moved.
 * ------------------------------------------------------------------------- */

export type StockTransferStatus = "draft" | "dispatched" | "partially_received" | "received" | "canceled";

export type IStockTransferItem = {
  productId: mongoose.Types.ObjectId;
  name: string;
  sku: string;
  quantity: number;
  /** Quantity received at the destination (<= quantity). */
  receivedQuantity: number;
  unitCost: number;
  batchNumber: string;
  expirationDate: Date | null;
  purchaseSource: PurchaseSource | null;
};

export type IStockTransferDocument = Document & {
  transferNumber: string;
  /** Branch ends of the transfer (null when that end is a warehouse). */
  fromBranchId: mongoose.Types.ObjectId | null;
  toBranchId: mongoose.Types.ObjectId | null;
  /** Warehouse ends of the transfer (null when that end is a shop). */
  fromWarehouseId: mongoose.Types.ObjectId | null;
  toWarehouseId: mongoose.Types.ObjectId | null;
  status: StockTransferStatus;
  items: IStockTransferItem[];
  note: string;
  /** Recorded reason for a short receipt (missing/damaged units). */
  discrepancyNote: string;
  createdBy: mongoose.Types.ObjectId;
  dispatchedBy: mongoose.Types.ObjectId | null;
  dispatchedAt: Date | null;
  receivedBy: mongoose.Types.ObjectId | null;
  receivedAt: Date | null;
  canceledBy: mongoose.Types.ObjectId | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const baseSchema = (options?: { timestamps?: boolean }) => {
  const s = new Schema<BaseDocument>(
    {},
    { timestamps: options?.timestamps ?? true }
  );
  return s;
};

export const RoleSchema = new Schema<IRoleDocument>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: "" },
    isSystem: { type: Boolean, default: true },
    permissions: [{ type: Schema.Types.ObjectId, ref: "Permission" }],
  },
  { timestamps: true }
);

export const PermissionSchema = new Schema<IPermissionDocument>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: "" },
    category: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

export const UserSchema = new Schema<IUserDocument>(
  {
    name: { type: String, required: true, trim: true, minlength: 2 },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    passwordHash: { type: String, required: true, select: false },
    roleId: { type: Schema.Types.ObjectId, ref: "Role", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    status: {
      type: String,
      enum: ["active", "inactive", "pending"],
      default: "pending",
    },
    // Employee purchase benefit: null = inherit the department/shop default.
    purchaseBenefitPercent: { type: Number, default: null, min: 0, max: 100 },
    purchaseOutstanding: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
    refreshTokenHash: { type: String, default: null },
    passwordResetTokenHash: { type: String, default: null },
    passwordResetExpires: { type: Date, default: null },
  },
  { timestamps: true }
);

UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ roleId: 1 });
UserSchema.index({ status: 1 });

export const BranchSchema = new Schema<IBranchDocument>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    address: { type: String, default: "" },
    phone: { type: String, default: "" },
    timezone: { type: String, default: "UTC" },
    currency: { type: String, default: "AFN" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    // Existing branches are shops; a warehouse is the same structure used as a
    // stock location (separate stock balance, never a selling register).
    type: { type: String, enum: ["shop", "warehouse"], default: "shop" },
    taxRate: { type: Number, default: 0 },
  },
  { timestamps: true }
);

BranchSchema.index({ code: 1 }, { unique: true });

export const WarehouseSchema = new Schema<IWarehouseDocument>(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    code: { type: String, default: "", trim: true, uppercase: true, maxlength: 20 },
    address: { type: String, default: "", trim: true, maxlength: 300 },
    phone: { type: String, default: "", trim: true, maxlength: 50 },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// A warehouse code is unique when set (empty codes are allowed).
WarehouseSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { code: { $type: "string", $ne: "" } } }
);
WarehouseSchema.index({ name: 1 });
WarehouseSchema.index({ status: 1 });

export const CategorySchema = new Schema<ICategoryDocument>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    parentId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

CategorySchema.index({ parentId: 1 });

export const BrandSchema = new Schema<IBrandDocument>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

BrandSchema.index({ name: 1 }, { unique: true });

export const ProductSchema = new Schema<IProductDocument>(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: "", trim: true },
    // NOTE: no `default: ""` on purpose — barcode_1 is a unique SPARSE index,
    // and "" is a value, not a missing field, so two barcode-less products
    // would E11000 against each other. Leaving the path unset lets the sparse
    // index skip those documents.
    barcode: { type: String, trim: true },
    // Extra barcodes live in a separate array so the legacy single `barcode`
    // field keeps working untouched. Uniqueness is enforced in application
    // code across BOTH fields (one barcode = one sellable product/variant).
    barcodes: {
      type: [
        new Schema(
          {
            code: { type: String, required: true, trim: true },
            label: { type: String, default: "", trim: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    description: { type: String, default: "" },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", default: null },
    // A product belongs to one department; sales of the product are attributed
    // to that department in the department report.
    departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    purchaseSource: { type: String, enum: ["import", "local", null], default: null },
    costPrice: { type: Number, default: 0, min: 0 },
    sellingPrice: { type: Number, default: 0, min: 0 },
    discountPrice: { type: Number, default: 0, min: 0 },
    taxRate: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    reorderPoint: { type: Number, default: 0, min: 0 },
    // Optional product-level expiry for products that are not received in
    // dated batches. Dated purchase batches always take precedence.
    expirationDate: { type: Date, default: null },
    // Variants are linked product rows: they keep their own SKU, price and
    // stock so flavour/packaging variants never mix inventory.
    parentProductId: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    variantName: { type: String, default: "", trim: true },
    status: { type: String, enum: ["active", "inactive", "archived"], default: "active" },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
  },
  { timestamps: true }
);

ProductSchema.index({ sku: 1 }, { unique: true, sparse: true });
ProductSchema.index({ barcode: 1 }, { unique: true, sparse: true });
// Unique multikey index: the same extra barcode can never be assigned twice.
ProductSchema.index({ "barcodes.code": 1 }, { unique: true, sparse: true });
ProductSchema.index({ parentProductId: 1 });
ProductSchema.index({ expirationDate: 1 });
ProductSchema.index({ categoryId: 1 });
ProductSchema.index({ brandId: 1 });
ProductSchema.index({ departmentId: 1 });
ProductSchema.index({ status: 1 });
ProductSchema.index({ branchId: 1 });

export const InventoryMovementSchema = new Schema<IInventoryMovementDocument>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    // null = head-office / unassigned stock: every writer (POS sale, purchase
    // receipt, adjustment, return) passes `branchId ?? null` for branchless
    // users, and branch-scoped queries only add a branchId condition when the
    // caller has one. Requiring a value here broke every stock mutation for
    // HQ users with a ValidationError → 500.
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    // Stock held in a standalone warehouse (never a branch).
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", default: null },
    movementType: {
      type: String,
      enum: ["PURCHASE_IN", "SALE_OUT", "CUSTOMER_RETURN_IN", "SUPPLIER_RETURN_OUT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "STOCK_COUNT_IN", "STOCK_COUNT_OUT", "TRANSFER_IN", "TRANSFER_OUT"],
      required: true,
    },
    quantity: { type: Number, required: true },
    unitCost: { type: Number, default: 0, min: 0 },
    batchNumber: { type: String, default: "", trim: true },
    expirationDate: { type: Date, default: null },
    // null = legacy/unbatched stock (origin unknown).
    purchaseSource: { type: String, enum: ["import", "local", null], default: null },
    referenceType: {
      type: String,
      enum: ["sale", "purchase", "adjustment", "count", "transfer", "damage", "return", null],
      default: null,
    },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    note: { type: String, default: "" },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

InventoryMovementSchema.index({ productId: 1, branchId: 1 });
InventoryMovementSchema.index({ productId: 1, batchNumber: 1 });
InventoryMovementSchema.index({ productId: 1, branchId: 1, createdAt: -1 });
InventoryMovementSchema.index({ productId: 1, warehouseId: 1, createdAt: -1 });
InventoryMovementSchema.index({ referenceType: 1, referenceId: 1 });

export const SaleSchema = new Schema<ISaleDocument>(
  {
    invoiceNumber: { type: String, required: true, trim: true },
    clientTransactionId: { type: String, default: null, trim: true },
    deviceId: { type: String, default: null, trim: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
    cashierId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    departmentName: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["completed", "canceled", "held"],
      default: "completed",
    },
    items: [
      {
        // Direct-sale lines carry no product reference (null) and are never
        // written to the inventory ledger.
        productId: { type: Schema.Types.ObjectId, ref: "Product", default: null },
        itemType: { type: String, enum: ["inventory", "direct"], default: "inventory" },
        pricingMode: { type: String, enum: ["retail", "wholesale"], default: "retail" },
        name: { type: String, required: true },
        sku: { type: String, required: true },
        quantity: { type: Number, required: true, min: 0 },
        sellingPrice: { type: Number, required: true, min: 0 },
        costPrice: { type: Number, required: true, min: 0 },
        discount: { type: Number, default: 0, min: 0 },
        tax: { type: Number, default: 0, min: 0 },
        subtotal: { type: Number, required: true, min: 0 },
        purchaseSource: { type: String, enum: ["import", "local", null], default: null },
        // Product's department, snapshotted per line for the department report.
        departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
        departmentName: { type: String, default: "", trim: true },
      },
    ],
    subtotal: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    discountType: { type: String, enum: ["amount", "percent"], default: "amount" },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    changeAmount: { type: Number, default: 0, min: 0 },
    paymentMethod: {
      type: String,
      enum: ["cash", "card", "transfer", "credit", "bonus", "exchange", "mixed", null],
      default: null,
    },
    payments: [
      {
        method: { type: String, enum: ["cash", "card", "transfer", "credit", "bonus", "exchange"], required: true },
        amount: { type: Number, required: true, min: 0 },
        reference: { type: String, default: "" },
      },
    ],
    pricingMode: { type: String, enum: ["retail", "wholesale"], default: "retail" },
    bonusPercent: { type: Number, default: 0, min: 0, max: 100 },
    bonusEarned: { type: Number, default: 0 },
    bonusRedeemed: { type: Number, default: 0, min: 0 },
    bonusEarnBase: { type: Number, default: 0, min: 0 },
    // Reward credit is only credited when the cashier asks for it, and never
    // twice for the same sale.
    bonusGranted: { type: Boolean, default: true },
    originalSaleId: { type: Schema.Types.ObjectId, ref: "Sale", default: null },
    exchangeReturnId: { type: Schema.Types.ObjectId, ref: "SaleReturn", default: null },
    registerId: { type: Schema.Types.ObjectId, ref: "CashRegister", default: null },
    heldAt: { type: Date, default: null },
    heldBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

SaleSchema.index({ branchId: 1, createdAt: -1 });
SaleSchema.index({ customerId: 1 });
SaleSchema.index({ cashierId: 1 });
SaleSchema.index({ status: 1 });
SaleSchema.index({ invoiceNumber: 1 }, { unique: true });
// Idempotency for offline sync: at most one sale per client-generated
// transaction id. Partial (only string values) so sales without a client id
// — including explicit nulls — are never part of the uniqueness constraint.
SaleSchema.index(
  { clientTransactionId: 1 },
  { unique: true, partialFilterExpression: { clientTransactionId: { $type: "string" } } }
);
SaleSchema.index({ "items.productId": 1 });

export const PurchaseSchema = new Schema<IPurchaseDocument>(
  {
    // null = HQ purchase (supplier without a branch) — see InventoryMovementSchema.
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", required: true },
    purchaseNumber: { type: String, required: true, trim: true },
    // Defaults to local so purchases created by older clients stay valid.
    purchaseSource: { type: String, enum: ["import", "local"], default: "local" },
    // Snapshotted department so a purchase stays attributed after a rename.
    departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    departmentName: { type: String, default: "Shop", trim: true },
    status: {
      type: String,
      enum: ["draft", "pending", "completed", "canceled"],
      default: "pending",
    },
    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
        name: { type: String, required: true },
        sku: { type: String, required: true },
        quantity: { type: Number, required: true, min: 0 },
        purchasePrice: { type: Number, default: 0, min: 0 },
        sellingPrice: { type: Number, default: 0, min: 0 },
        costPrice: { type: Number, default: 0, min: 0 },
        discount: { type: Number, default: 0, min: 0 },
        tax: { type: Number, default: 0, min: 0 },
        subtotal: { type: Number, required: true, min: 0 },
        batchNumber: { type: String, default: "", trim: true },
        expirationDate: { type: Date, default: null },
      },
    ],
    subtotal: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    dueAmount: { type: Number, default: 0, min: 0 },
    paymentMethod: {
      type: String,
      enum: ["cash", "card", "transfer", "check", "account", "other"],
      default: "cash",
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

PurchaseSchema.index({ purchaseNumber: 1 }, { unique: true });
PurchaseSchema.index({ branchId: 1, createdAt: -1 });
PurchaseSchema.index({ supplierId: 1 });
PurchaseSchema.index({ userId: 1 });
PurchaseSchema.index({ status: 1 });

export const CustomerSchema = new Schema<ICustomerDocument>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    phone: { type: String, default: "", trim: true },
    address: { type: String, default: "" },
    notes: { type: String, default: "" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    wholesaleEligible: { type: Boolean, default: false },
    bonusPercent: { type: Number, default: 0, min: 0, max: 100 },
    bonusBalance: { type: Number, default: 0 },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
  },
  { timestamps: true }
);

CustomerSchema.index({ branchId: 1, status: 1 });
CustomerSchema.index({ name: 1 });
CustomerSchema.index({ phone: 1 });

export const SupplierSchema = new Schema<ISupplierDocument>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    phone: { type: String, default: "", trim: true },
    address: { type: String, default: "" },
    note: { type: String, default: "" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    // null = supplier of the head office (created by an unrestricted user).
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
  },
  { timestamps: true }
);

SupplierSchema.index({ branchId: 1, status: 1 });

export const CustomerTransactionSchema = new Schema<ICustomerTransactionDocument>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    // null = ledger entry of an HQ customer (see InventoryMovementSchema).
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    type: {
      type: String,
      enum: ["SALE", "PAYMENT", "REFUND", "ADJUSTMENT"],
      required: true,
    },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    method: { type: String, default: "" },
    reference: { type: String, default: "" },
    referenceType: {
      type: String,
      enum: ["sale", "sale_return", "payment", "adjustment", null],
      default: null,
    },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    description: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

CustomerTransactionSchema.index({ customerId: 1, createdAt: -1 });
CustomerTransactionSchema.index({ type: 1, createdAt: -1 });
CustomerTransactionSchema.index({ referenceType: 1, referenceId: 1 });

export const CustomerBonusTransactionSchema = new Schema<ICustomerBonusTransactionDocument>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    type: {
      type: String,
      enum: ["EARN", "REDEEM", "REVERSAL", "RESTORE", "EXPIRE", "ADJUSTMENT"],
      required: true,
    },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    referenceType: { type: String, enum: ["sale", "sale_return", "adjustment", null], default: null },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    description: { type: String, required: true },
    // EARN rows only: when the acquired credit expires.
    expiresAt: { type: Date, default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, default: "", trim: true, maxlength: 300 },
    idempotencyKey: { type: String, required: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

CustomerBonusTransactionSchema.index({ customerId: 1, createdAt: -1 });
CustomerBonusTransactionSchema.index({ idempotencyKey: 1 }, { unique: true });
CustomerBonusTransactionSchema.index({ referenceType: 1, referenceId: 1 });

export const SupplierTransactionSchema = new Schema<ISupplierTransactionDocument>(
  {
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", required: true },
    // null = HQ supplier ledger (see InventoryMovementSchema).
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    type: {
      type: String,
      enum: ["purchase", "payment", "adjustment", "credit", "debit"],
      required: true,
    },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    method: { type: String, default: "" },
    reference: { type: String, default: "" },
    referenceType: {
      type: String,
      enum: ["purchase", "payment", "adjustment", "credit", "debit", null],
      default: null,
    },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    description: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

SupplierTransactionSchema.index({ supplierId: 1, createdAt: -1 });
SupplierTransactionSchema.index({ type: 1, createdAt: -1 });
SupplierTransactionSchema.index({ referenceType: 1, referenceId: 1 });

export const PaymentSchema = new Schema<IPaymentDocument>(
  {
    type: {
      type: String,
      enum: ["sale", "purchase", "account_receivable", "account_payable", "expense", "other"],
      required: true,
    },
    referenceType: {
      type: String,
      enum: ["sale", "purchase", "customer_transaction", "supplier_transaction", "expense", "cash_register", null],
      default: null,
    },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    amount: { type: Number, required: true, min: 0 },
    method: {
      type: String,
      enum: ["cash", "card", "transfer", "check", "account", "other"],
      required: true,
    },
    description: { type: String, default: "" },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
  },
  { timestamps: true }
);

PaymentSchema.index({ referenceType: 1, referenceId: 1 });
PaymentSchema.index({ branchId: 1, createdAt: -1 });

export const ExpenseSchema = new Schema<IExpenseDocument>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: "other", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["draft", "pending", "completed", "canceled"], default: "pending" },
    description: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    paymentMethod: {
      type: String,
      enum: ["cash", "card", "transfer", "check", "account", "other"],
      required: true,
    },
    reference: { type: String, default: "", trim: true },
    date: { type: Date, default: null },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

ExpenseSchema.index({ branchId: 1, date: -1 });
ExpenseSchema.index({ status: 1 });
ExpenseSchema.index({ category: 1 });

export const CashRegisterSchema = new Schema<ICashRegisterDocument>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    status: { type: String, enum: ["closed", "open", "closing"], default: "closed" },
    openCash: { type: Number, default: 0, min: 0 },
    expectedCash: { type: Number, default: 0, min: 0 },
    countedCash: { type: Number, default: null },
    difference: { type: Number, default: null },
    openedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    openedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

CashRegisterSchema.index({ branchId: 1, status: 1 });

export const CashTransactionSchema = new Schema<ICashTransactionDocument>(
  {
    registerId: { type: Schema.Types.ObjectId, ref: "CashRegister", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    type: {
      type: String,
      enum: ["opening", "sale", "refund", "expense", "income", "adjustment", "closing", "purchase", "payment_in", "payment_out"],
      required: true,
    },
    amount: { type: Number, required: true },
    description: { type: String, default: "" },
    referenceType: {
      type: String,
      enum: ["sale", "sale_return", "expense", "customer_payment", "supplier_payment", "income", "adjustment", null],
      default: null,
    },
    referenceId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

CashTransactionSchema.index({ registerId: 1, createdAt: -1 });
CashTransactionSchema.index({ registerId: 1, type: 1 });
CashTransactionSchema.index({ branchId: 1, createdAt: -1 });

export const SaleReturnSchema = new Schema<ISaleReturnDocument>(
  {
    returnNumber: { type: String, required: true, unique: true, trim: true },
    saleId: { type: Schema.Types.ObjectId, ref: "Sale", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    departmentName: { type: String, default: "", trim: true },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    clientTransactionId: { type: String, default: null, trim: true },
    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: "Product", default: null },
        itemType: { type: String, enum: ["inventory", "direct"], default: "inventory" },
        sourceLineId: { type: String, default: "" },
        restock: { type: Boolean, default: true },
        pricingMode: { type: String, enum: ["retail", "wholesale"], default: "retail" },
        name: { type: String, required: true },
        sku: { type: String, required: true },
        quantity: { type: Number, required: true, min: 0 },
        sellingPrice: { type: Number, required: true, min: 0 },
        costPrice: { type: Number, required: true, min: 0 },
        discount: { type: Number, default: 0, min: 0 },
        tax: { type: Number, default: 0, min: 0 },
        subtotal: { type: Number, required: true, min: 0 },
        departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
        departmentName: { type: String, default: "", trim: true },
      },
    ],
    subtotal: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    refundMethod: { type: String, enum: ["cash", "original", "credit", "card", "transfer"], default: "cash" },
    reason: { type: String, default: "", trim: true },
    note: { type: String, default: "" },
    exchangeSaleId: { type: Schema.Types.ObjectId, ref: "Sale", default: null },
    replacementTotal: { type: Number, default: 0, min: 0 },
    netAmount: { type: Number, default: 0 },
    bonusReversed: { type: Number, default: 0, min: 0 },
    bonusRestored: { type: Number, default: 0, min: 0 },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SaleReturnSchema.index({ saleId: 1 });
SaleReturnSchema.index({ branchId: 1, createdAt: -1 });
SaleReturnSchema.index({ status: 1 });
SaleReturnSchema.index(
  { clientTransactionId: 1 },
  { unique: true, partialFilterExpression: { clientTransactionId: { $type: "string" } } }
);

export const AuditLogSchema = new Schema<IAuditLogDocument>(
  {
    action: { type: String, required: true, trim: true },
    entityType: { type: String, required: true, trim: true },
    entityId: { type: Schema.Types.ObjectId, default: null },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    changes: { type: Map, of: Schema.Types.Mixed },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    note: { type: String, default: null },
  },
  { timestamps: true }
);

AuditLogSchema.index({ userId: 1 });
AuditLogSchema.index({ entityType: 1, entityId: 1 });
AuditLogSchema.index({ createdAt: -1 });

export const StoreSettingsSchema = new Schema<IStoreSettingsDocument>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    key: { type: String, required: true, trim: true },
    value: { type: Schema.Types.Mixed },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

StoreSettingsSchema.index({ branchId: 1, key: 1 }, { unique: true });

export const StoreProductSchema = new Schema<IStoreProductDocument>(
  {
    name: { type: String, required: true, trim: true, minlength: 2 },
    slug: { type: String, required: true, trim: true, lowercase: true },
    description: { type: String, default: "", trim: true },
    price: { type: Number, required: true, min: 0 },
    compareAtPrice: { type: Number, default: 0, min: 0 },
    accent: { type: String, default: "indigo", trim: true },
    imageUrl: { type: String, default: "", trim: true },
    category: { type: String, default: "General", trim: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    stock: { type: Number, default: 0, min: 0 },
    featured: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

StoreProductSchema.index({ slug: 1 }, { unique: true });
StoreProductSchema.index({ status: 1, createdAt: -1 });
StoreProductSchema.index({ category: 1 });
StoreProductSchema.index({ categoryId: 1 });

export const StoreOrderSchema = new Schema<IStoreOrderDocument>(
  {
    orderNumber: { type: String, required: true, unique: true, trim: true },
    customerName: { type: String, required: true, trim: true, minlength: 2 },
    phone: { type: String, required: true, trim: true, minlength: 6 },
    email: { type: String, default: "", trim: true, lowercase: true },
    address: { type: String, default: "", trim: true },
    note: { type: String, default: "", trim: true },
    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: "StoreProduct", required: true },
        name: { type: String, required: true },
        price: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 1 },
      },
    ],
    subtotal: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["pending", "confirmed", "shipped", "delivered", "canceled"],
      default: "pending",
    },
  },
  { timestamps: true }
);

StoreOrderSchema.index({ createdAt: -1 });
StoreOrderSchema.index({ status: 1, createdAt: -1 });
StoreOrderSchema.index({ phone: 1 });
StoreOrderSchema.index({ "items.productId": 1 });

export const DepartmentSchema = new Schema<IDepartmentDocument>(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    code: { type: String, default: "", trim: true, uppercase: true, maxlength: 20 },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Department-level employee purchase rate; null inherits the shop default.
    purchaseBenefitPercent: { type: Number, default: null, min: 0, max: 100 },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    deactivatedAt: { type: Date, default: null },
    deactivatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// One name per shop.
DepartmentSchema.index({ branchId: 1, name: 1 }, { unique: true });
// An employee may head at most ONE active department in the same shop.
DepartmentSchema.index(
  { branchId: 1, employeeId: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);
DepartmentSchema.index({ employeeId: 1, status: 1 });

export const EmployeeSalarySchema = new Schema<IEmployeeSalaryDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    monthlySalary: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "AFN", trim: true, maxlength: 8 },
    effectiveFrom: { type: Date, default: Date.now },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// One current salary configuration per employee.
EmployeeSalarySchema.index({ userId: 1 }, { unique: true });
EmployeeSalarySchema.index({ branchId: 1, status: 1 });

export const AttendanceRecordSchema = new Schema<IAttendanceRecordDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    dateKey: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    date: { type: Date, required: true },
    status: { type: String, enum: ["absent", "leave", "rest", "holiday"], required: true },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    markedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// At most one attendance exception per employee per calendar day.
AttendanceRecordSchema.index({ userId: 1, dateKey: 1 }, { unique: true });
AttendanceRecordSchema.index({ branchId: 1, dateKey: 1 });

export const PayrollPeriodSchema = new Schema<IPayrollPeriodDocument>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    period: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}$/ },
    status: { type: String, enum: ["draft", "finalized"], default: "draft" },
    totals: {
      employees: { type: Number, default: 0, min: 0 },
      grossSalary: { type: Number, default: 0 },
      deductions: { type: Number, default: 0, min: 0 },
      netPayable: { type: Number, default: 0 },
      paidAmount: { type: Number, default: 0, min: 0 },
      outstanding: { type: Number, default: 0 },
      absentDays: { type: Number, default: 0, min: 0 },
    },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    generatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    generatedAt: { type: Date, default: null },
    finalizedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    finalizedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One payroll run per shop per month.
PayrollPeriodSchema.index({ branchId: 1, period: 1 }, { unique: true });

export const PayrollEntrySchema = new Schema<IPayrollEntryDocument>(
  {
    payrollId: { type: Schema.Types.ObjectId, ref: "PayrollPeriod", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, default: "", trim: true },
    period: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}$/ },
    monthlySalary: { type: Number, default: 0, min: 0 },
    calendarDays: { type: Number, default: 0, min: 0 },
    scheduledDays: { type: Number, default: 0, min: 0 },
    restDays: { type: Number, default: 0, min: 0 },
    leaveDays: { type: Number, default: 0, min: 0 },
    absentDays: { type: Number, default: 0, min: 0 },
    allowanceDays: { type: Number, default: 0, min: 0 },
    unpaidAbsenceDays: { type: Number, default: 0, min: 0 },
    dailyRate: { type: Number, default: 0, min: 0 },
    deduction: { type: Number, default: 0, min: 0 },
    purchaseDeduction: { type: Number, default: 0, min: 0 },
    netPayable: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["unpaid", "partial", "paid"], default: "unpaid" },
    lastPaidAt: { type: Date, default: null },
    note: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

// One entry per employee per run, and one payable month per employee per shop
// — the DB-level guard against paying the same period twice.
PayrollEntrySchema.index({ payrollId: 1, userId: 1 }, { unique: true });
PayrollEntrySchema.index({ userId: 1, period: 1, branchId: 1 }, { unique: true });
PayrollEntrySchema.index({ period: 1, status: 1 });

export const EmployeePurchaseSchema = new Schema<IEmployeePurchaseDocument>(
  {
    purchaseNumber: { type: String, required: true, trim: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    saleId: { type: Schema.Types.ObjectId, ref: "Sale", required: true },
    invoiceNumber: { type: String, default: "", trim: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    employeeName: { type: String, default: "", trim: true },
    departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    departmentName: { type: String, default: "", trim: true },
    cashierId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    benefitMode: { type: String, enum: ["percent", "fixed"], default: "percent" },
    benefitPercent: { type: Number, default: 0, min: 0, max: 100 },
    grossAmount: { type: Number, default: 0, min: 0 },
    benefitAmount: { type: Number, default: 0, min: 0 },
    netAmount: { type: Number, default: 0, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    outstandingAmount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["open", "settled", "deducted", "canceled", "refunded"],
      default: "open",
    },
    payrollPeriod: { type: String, default: "", trim: true },
    payrollDeductionId: { type: Schema.Types.ObjectId, ref: "EmployeePurchaseDeduction", default: null },
    payrollExcluded: { type: Boolean, default: false },
    note: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

// One employee purchase per sale — retries and sync can never double-create it.
EmployeePurchaseSchema.index({ saleId: 1 }, { unique: true });
EmployeePurchaseSchema.index({ purchaseNumber: 1 }, { unique: true });
EmployeePurchaseSchema.index({ employeeId: 1, createdAt: -1 });
EmployeePurchaseSchema.index({ branchId: 1, status: 1, createdAt: -1 });

// Written to be replicated; keep the index definitions in step with the local
// MongoDB node so the unique guards also exist offline.
export const EmployeePurchasePaymentSchema = new Schema<IEmployeePurchasePaymentDocument>(
  {
    employeePurchaseId: { type: Schema.Types.ObjectId, ref: "EmployeePurchase", required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, default: "cash", trim: true },
    reference: { type: String, default: "", trim: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    idempotencyKey: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

EmployeePurchasePaymentSchema.index({ idempotencyKey: 1 }, { unique: true });
EmployeePurchasePaymentSchema.index({ employeePurchaseId: 1, createdAt: -1 });
EmployeePurchasePaymentSchema.index({ employeeId: 1, createdAt: -1 });

export const EmployeePurchaseDeductionSchema = new Schema<IEmployeePurchaseDeductionDocument>(
  {
    employeePurchaseId: { type: Schema.Types.ObjectId, ref: "EmployeePurchase", required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    payrollId: { type: Schema.Types.ObjectId, ref: "PayrollPeriod", required: true },
    payrollEntryId: { type: Schema.Types.ObjectId, ref: "PayrollEntry", required: true },
    period: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ["pending", "applied", "reversed"], default: "pending" },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    idempotencyKey: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

// A purchase can be deducted at most once per payroll month — even if payroll
// is regenerated. A partially recovered purchase may continue next month.
EmployeePurchaseDeductionSchema.index({ employeePurchaseId: 1, period: 1 }, { unique: true });
EmployeePurchaseDeductionSchema.index({ idempotencyKey: 1 }, { unique: true });
EmployeePurchaseDeductionSchema.index({ payrollEntryId: 1 });
EmployeePurchaseDeductionSchema.index({ period: 1, status: 1 });

export const EmployeePurchaseLedgerSchema = new Schema<IEmployeePurchaseLedgerDocument>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    employeePurchaseId: { type: Schema.Types.ObjectId, ref: "EmployeePurchase", default: null },
    type: {
      type: String,
      enum: ["PURCHASE", "BENEFIT", "PAYMENT", "DEDUCTION", "REFUND", "ADJUSTMENT"],
      required: true,
    },
    amount: { type: Number, required: true },
    balanceDelta: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    referenceType: { type: String, enum: ["sale", "sale_return", "payment", "payroll", "adjustment", null], default: null },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    description: { type: String, required: true },
    idempotencyKey: { type: String, required: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

EmployeePurchaseLedgerSchema.index({ idempotencyKey: 1 }, { unique: true });
EmployeePurchaseLedgerSchema.index({ employeeId: 1, createdAt: -1 });
EmployeePurchaseLedgerSchema.index({ employeePurchaseId: 1, createdAt: 1 });

export const StockTransferSchema = new Schema<IStockTransferDocument>(
  {
    transferNumber: { type: String, required: true, trim: true },
    // Each transfer end is EITHER a branch or a warehouse, never both.
    fromBranchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    toBranchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    fromWarehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", default: null },
    toWarehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", default: null },
    status: {
      type: String,
      enum: ["draft", "dispatched", "partially_received", "received", "canceled"],
      default: "draft",
    },
    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
        name: { type: String, required: true },
        sku: { type: String, default: "", trim: true },
        quantity: { type: Number, required: true, min: 1 },
        receivedQuantity: { type: Number, default: 0, min: 0 },
        unitCost: { type: Number, default: 0, min: 0 },
        batchNumber: { type: String, default: "", trim: true },
        expirationDate: { type: Date, default: null },
        purchaseSource: { type: String, enum: ["import", "local", null], default: null },
      },
    ],
    note: { type: String, default: "", trim: true, maxlength: 500 },
    discrepancyNote: { type: String, default: "", trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    dispatchedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    dispatchedAt: { type: Date, default: null },
    receivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    receivedAt: { type: Date, default: null },
    canceledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    canceledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

StockTransferSchema.index({ transferNumber: 1 }, { unique: true });
StockTransferSchema.index({ fromBranchId: 1, status: 1, createdAt: -1 });
StockTransferSchema.index({ toBranchId: 1, status: 1, createdAt: -1 });
StockTransferSchema.index({ fromWarehouseId: 1, status: 1, createdAt: -1 });
StockTransferSchema.index({ toWarehouseId: 1, status: 1, createdAt: -1 });

/* ---------------------------------------------------------------------------
 * Offline-first synchronization (see docs/OFFLINE.md)
 *
 * A shop PC owns its LOCAL MongoDB and serves every request from it. The
 * collections below are that node's pending-change bookkeeping plus the
 * center's ingest ledger:
 *
 *  SyncOutbox      node   one row per dirty document awaiting push
 *  SyncState       node   key/value state (pull cursors, local schema version)
 *  SyncConflict    node   operations the center refused (payload preserved)
 *  SyncRun         node   history of sync runs (summary shown in the UI)
 *  SyncNode        center registered shop nodes + hashed keys
 *  SyncAppliedOp   center at-most-once ledger for pushed rows
 *
 * The outbox stores a dirty MARKER, not a payload: the worker reads the
 * document's current state from the local database when it pushes, so a
 * document edited twice before a sync is replicated once, in its latest form.
 * ------------------------------------------------------------------------- */

export type SyncOutboxOperation = "upsert" | "delete";
export type SyncOutboxStatus = "PENDING" | "SENDING" | "SYNCED" | "FAILED";

export type ISyncOutboxDocument = Document & {
  /** Unique per change; doubles as the center's idempotency key. */
  rowKey: string;
  /** MongoDB collection name ("sales", "products", …).
   *  Named `collectionName` because `Document.collection` is the driver handle. */
  collectionName: string;
  docId: string;
  operation: SyncOutboxOperation;
  /** Dependency band (lower = pushed/applied first). */
  priority: number;
  status: SyncOutboxStatus;
  attempts: number;
  /** epoch ms — earliest time the next attempt may run. */
  nextAttemptAt: number;
  /** When the in-flight push claimed the row (null when not in flight). */
  claimedAt: Date | null;
  lastError: string | null;
  /** User whose action produced the change (re-authorized by the center). */
  actorUserId: mongoose.Types.ObjectId | null;
  branchId: mongoose.Types.ObjectId | null;
  /** Coarse entity label for the UI ("Sale", "Product", …). */
  entityType: string;
  /** `updatedAt` of the document when it was marked dirty (staleness guard). */
  docVersion: Date | null;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ISyncStateDocument = Document & {
  key: string;
  value: unknown;
  updatedAt: Date;
};

export type SyncConflictKind =
  | "PERMISSION_DENIED"
  | "VALIDATION"
  | "STALE_OVERWRITE"
  | "UNSUPPORTED"
  | "SERVER_ERROR";

export type ISyncConflictDocument = Document & {
  /** Deterministic id — one conflict row per outbox row. */
  conflictKey: string;
  rowKey: string;
  collectionName: string;
  docId: string;
  entityType: string;
  kind: SyncConflictKind;
  message: string;
  /** Snapshot of the local document at failure time (never discard the data). */
  payload: unknown;
  /** Document can be pushed again after the cause is fixed. */
  retryable: boolean;
  resolved: boolean;
  resolution: string;
  resolvedBy: mongoose.Types.ObjectId | null;
  resolvedAt: Date | null;
  nodeId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SyncRunStatus = "running" | "completed" | "failed";

export type ISyncRunDocument = Document & {
  /** "push" | "pull" | "full" — what the run covered. */
  kind: string;
  status: SyncRunStatus;
  pushed: number;
  failed: number;
  conflicted: number;
  remaining: number;
  pulled: number;
  message: string;
  startedAt: Date;
  finishedAt: Date | null;
  nodeId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ISyncNodeDocument = Document & {
  /** Stable node identity (SYNC_NODE_ID on the shop PC). */
  nodeId: string;
  name: string;
  /** Hashed node key. The plaintext key is shown once, when it is issued. */
  keyHash: string;
  branchId: mongoose.Types.ObjectId | null;
  status: "active" | "inactive";
  lastSeenAt: Date | null;
  lastPushAt: Date | null;
  lastPullAt: Date | null;
  pushedRows: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ISyncAppliedOpDocument = Document & {
  nodeId: string;
  rowKey: string;
  collectionName: string;
  docId: string;
  /** "applied" | "skipped" — the ledger records any row that will not run again. */
  outcome: string;
  appliedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Replication tables (dependency bands, tracked collections, pull set) live in
 * a dependency-free module so the model layer, the tracker and the worker can
 * all share them without an import cycle. Re-exported here for convenience.
 */
export {
  SYNC_COLLECTION_PRIORITY,
  SYNC_TRACKED_COLLECTIONS,
  SYNC_PULL_COLLECTIONS,
  collectionPriority,
} from "@/lib/sync/collections";

export const SyncOutboxSchema = new Schema<ISyncOutboxDocument>(
  {
    rowKey: { type: String, required: true, trim: true },
    collectionName: { type: String, required: true, trim: true },
    docId: { type: String, required: true, trim: true },
    operation: { type: String, enum: ["upsert", "delete"], required: true },
    priority: { type: Number, default: 100 },
    status: {
      type: String,
      enum: ["PENDING", "SENDING", "SYNCED", "FAILED"],
      default: "PENDING",
    },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Number, default: 0 },
    /** When the current push claimed the row; drives stuck-row recovery. */
    claimedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    entityType: { type: String, default: "" },
    docVersion: { type: Date, default: null },
    syncedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
SyncOutboxSchema.index({ rowKey: 1 }, { unique: true });
SyncOutboxSchema.index({ status: 1, nextAttemptAt: 1, priority: 1, createdAt: 1 });
// Deliberately NOT unique on (collection, docId, status): two registers on the
// same PC can dirty the same document at the same moment, and a duplicate-key
// error inside a sale transaction would abort the sale. Extra pending rows for
// one document are harmless — the worker collapses them into a single
// operation and marks every row for that document as synced.
SyncOutboxSchema.index({ collectionName: 1, docId: 1, status: 1 });

export const SyncStateSchema = new Schema<ISyncStateDocument>(
  {
    key: { type: String, required: true, trim: true },
    value: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);
SyncStateSchema.index({ key: 1 }, { unique: true });

export const SyncConflictSchema = new Schema<ISyncConflictDocument>(
  {
    conflictKey: { type: String, required: true, trim: true },
    rowKey: { type: String, required: true, trim: true },
    collectionName: { type: String, required: true, trim: true },
    docId: { type: String, required: true, trim: true },
    entityType: { type: String, default: "" },
    kind: {
      type: String,
      enum: ["PERMISSION_DENIED", "VALIDATION", "STALE_OVERWRITE", "UNSUPPORTED", "SERVER_ERROR"],
      required: true,
    },
    message: { type: String, default: "" },
    payload: { type: Schema.Types.Mixed },
    retryable: { type: Boolean, default: false },
    resolved: { type: Boolean, default: false },
    resolution: { type: String, default: "" },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
    nodeId: { type: String, default: "" },
  },
  { timestamps: true }
);
SyncConflictSchema.index({ conflictKey: 1 }, { unique: true });
SyncConflictSchema.index({ resolved: 1, createdAt: -1 });

export const SyncRunSchema = new Schema<ISyncRunDocument>(
  {
    kind: { type: String, default: "full" },
    status: { type: String, enum: ["running", "completed", "failed"], default: "running" },
    pushed: { type: Number, default: 0, min: 0 },
    failed: { type: Number, default: 0, min: 0 },
    conflicted: { type: Number, default: 0, min: 0 },
    remaining: { type: Number, default: 0, min: 0 },
    pulled: { type: Number, default: 0, min: 0 },
    message: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    nodeId: { type: String, default: "" },
  },
  { timestamps: true }
);
SyncRunSchema.index({ createdAt: -1 });

export const SyncNodeSchema = new Schema<ISyncNodeDocument>(
  {
    nodeId: { type: String, required: true, trim: true },
    name: { type: String, default: "", trim: true },
    keyHash: { type: String, required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    lastSeenAt: { type: Date, default: null },
    lastPushAt: { type: Date, default: null },
    lastPullAt: { type: Date, default: null },
    pushedRows: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);
SyncNodeSchema.index({ nodeId: 1 }, { unique: true });

export const SyncAppliedOpSchema = new Schema<ISyncAppliedOpDocument>(
  {
    nodeId: { type: String, required: true, trim: true },
    rowKey: { type: String, required: true, trim: true },
    collectionName: { type: String, default: "" },
    docId: { type: String, default: "" },
    outcome: { type: String, default: "applied" },
    appliedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
SyncAppliedOpSchema.index({ nodeId: 1, rowKey: 1 }, { unique: true });
SyncAppliedOpSchema.index({ appliedAt: -1 });

/* ----------------------------------------------------------------------------
 * Dirty-document tracking
 *
 * Every replicated schema queues a marker whenever the app writes one of its
 * documents, which is what the shop node pushes to the center. Registered
 * before the models are compiled; collections outside the replication table
 * (and the sync bookkeeping collections themselves) are ignored at runtime.
 * ------------------------------------------------------------------------- */
const REPLICATED_SCHEMAS: Schema[] = [
  RoleSchema,
  PermissionSchema,
  UserSchema,
  BranchSchema,
  WarehouseSchema,
  CategorySchema,
  BrandSchema,
  ProductSchema,
  CustomerSchema,
  SupplierSchema,
  PurchaseSchema,
  CashRegisterSchema,
  InventoryMovementSchema,
  SaleSchema,
  SaleReturnSchema,
  CustomerTransactionSchema,
  CustomerBonusTransactionSchema,
  SupplierTransactionSchema,
  CashTransactionSchema,
  PaymentSchema,
  ExpenseSchema,
  StoreOrderSchema,
  StoreProductSchema,
  StoreSettingsSchema,
  AuditLogSchema,
  DepartmentSchema,
  EmployeeSalarySchema,
  AttendanceRecordSchema,
  PayrollPeriodSchema,
  PayrollEntrySchema,
  EmployeePurchaseSchema,
  EmployeePurchasePaymentSchema,
  EmployeePurchaseDeductionSchema,
  EmployeePurchaseLedgerSchema,
  StockTransferSchema,
];

for (const replicatedSchema of REPLICATED_SCHEMAS) {
  syncTrackingPlugin(replicatedSchema);
}

/**
 * HMR-safe typed model accessor: reuses the compiled model when it already exists
 * (e.g. after hot reload) while keeping the full `Model<T>` type for inference.
 * (`mongoose.models.X` alone types as `Model<any>`, which breaks typed populate calls.)
 */
function getModel<T extends Document>(name: string, schema: Schema): Model<T> {
  const existing = mongoose.models[name] as Model<T> | undefined;
  if (existing) return existing;
  return mongoose.model<T>(name, schema as unknown as Schema<T>);
}

export const Role = getModel<IRoleDocument>("Role", RoleSchema);
export const PermissionModel = getModel<IPermissionDocument>("Permission", PermissionSchema);
// backwards compatibility: Permission is the document type, PermissionModel is the mongoose model
export type Permission = IPermissionDocument;
export const Permission = PermissionModel;
export const User = getModel<IUserDocument>("User", UserSchema);
export const Branch = getModel<IBranchDocument>("Branch", BranchSchema);
export const Warehouse = getModel<IWarehouseDocument>("Warehouse", WarehouseSchema);
export const Category = getModel<ICategoryDocument>("Category", CategorySchema);
export const Brand = getModel<IBrandDocument>("Brand", BrandSchema);
export const Product = getModel<IProductDocument>("Product", ProductSchema);
export const InventoryMovement = getModel<IInventoryMovementDocument>("InventoryMovement", InventoryMovementSchema);
export const Sale = getModel<ISaleDocument>("Sale", SaleSchema);
export const Purchase = getModel<IPurchaseDocument>("Purchase", PurchaseSchema);
export const Customer = getModel<ICustomerDocument>("Customer", CustomerSchema);
export const Supplier = getModel<ISupplierDocument>("Supplier", SupplierSchema);
export const CustomerTransaction = getModel<ICustomerTransactionDocument>("CustomerTransaction", CustomerTransactionSchema);
export const CustomerBonusTransaction = getModel<ICustomerBonusTransactionDocument>("CustomerBonusTransaction", CustomerBonusTransactionSchema);
export const SupplierTransaction = getModel<ISupplierTransactionDocument>("SupplierTransaction", SupplierTransactionSchema);
export const Payment = getModel<IPaymentDocument>("Payment", PaymentSchema);
export const Expense = getModel<IExpenseDocument>("Expense", ExpenseSchema);
export const CashRegister = getModel<ICashRegisterDocument>("CashRegister", CashRegisterSchema);
export const CashTransaction = getModel<ICashTransactionDocument>("CashTransaction", CashTransactionSchema);
export const SaleReturn = getModel<ISaleReturnDocument>("SaleReturn", SaleReturnSchema);
export const AuditLog = getModel<IAuditLogDocument>("AuditLog", AuditLogSchema);
export const StoreSettings = getModel<IStoreSettingsDocument>("StoreSettings", StoreSettingsSchema);
export const StoreProduct = getModel<IStoreProductDocument>("StoreProduct", StoreProductSchema);
export const StoreOrder = getModel<IStoreOrderDocument>("StoreOrder", StoreOrderSchema);
export const Department = getModel<IDepartmentDocument>("Department", DepartmentSchema);
export const EmployeeSalary = getModel<IEmployeeSalaryDocument>("EmployeeSalary", EmployeeSalarySchema);
export const AttendanceRecord = getModel<IAttendanceRecordDocument>("AttendanceRecord", AttendanceRecordSchema);
export const PayrollPeriod = getModel<IPayrollPeriodDocument>("PayrollPeriod", PayrollPeriodSchema);
export const PayrollEntry = getModel<IPayrollEntryDocument>("PayrollEntry", PayrollEntrySchema);
export const EmployeePurchase = getModel<IEmployeePurchaseDocument>("EmployeePurchase", EmployeePurchaseSchema);
export const EmployeePurchasePayment = getModel<IEmployeePurchasePaymentDocument>(
  "EmployeePurchasePayment",
  EmployeePurchasePaymentSchema
);
export const EmployeePurchaseDeduction = getModel<IEmployeePurchaseDeductionDocument>(
  "EmployeePurchaseDeduction",
  EmployeePurchaseDeductionSchema
);
export const EmployeePurchaseLedger = getModel<IEmployeePurchaseLedgerDocument>(
  "EmployeePurchaseLedger",
  EmployeePurchaseLedgerSchema
);
export const StockTransfer = getModel<IStockTransferDocument>("StockTransfer", StockTransferSchema);

/* ------------------- offline-first sync collections ------------------- */
export const SyncOutbox = getModel<ISyncOutboxDocument>("SyncOutbox", SyncOutboxSchema);
export const SyncState = getModel<ISyncStateDocument>("SyncState", SyncStateSchema);
export const SyncConflict = getModel<ISyncConflictDocument>("SyncConflict", SyncConflictSchema);
export const SyncRun = getModel<ISyncRunDocument>("SyncRun", SyncRunSchema);
export const SyncNode = getModel<ISyncNodeDocument>("SyncNode", SyncNodeSchema);
export const SyncAppliedOp = getModel<ISyncAppliedOpDocument>("SyncAppliedOp", SyncAppliedOpSchema);
