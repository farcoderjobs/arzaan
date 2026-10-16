import mongoose, { Schema, Document, Model } from "mongoose";

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
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  refreshTokenHash: string | null;
  passwordResetTokenHash: string | null;
  passwordResetExpires: Date | null;
};

export type IBranchDocument = Document & {
  name: string;
  code: string;
  address: string;
  phone: string;
  timezone: string;
  currency: string;
  status: "active" | "inactive";
  taxRate: number;
  createdAt: Date;
  updatedAt: Date;
};

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

export type IProductDocument = Document & {
  name: string;
  sku: string;
  barcode: string;
  description: string;
  categoryId: mongoose.Types.ObjectId;
  brandId: mongoose.Types.ObjectId | null;
  costPrice: number;
  sellingPrice: number;
  discountPrice: number;
  taxRate: number;
  discount: number;
  reorderPoint: number;
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
  | "STOCK_COUNT_OUT";

export type IInventoryMovementDocument = Document & {
  productId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId | null;
  movementType: InventoryMovementType;
  quantity: number;
  unitCost: number;
  referenceType: "sale" | "purchase" | "adjustment" | "count" | "transfer" | "damage" | "return" | null;
  referenceId: mongoose.Types.ObjectId | null;
  note: string;
  userId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type ISaleItemSnapshot = {
  productId: mongoose.Types.ObjectId;
  name: string;
  sku: string;
  quantity: number;
  sellingPrice: number;
  costPrice: number;
  discount: number;
  tax: number;
  subtotal: number;
};

export type ISalePayment = {
  method: "cash" | "card" | "transfer" | "credit";
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
  paymentMethod: "cash" | "card" | "transfer" | "credit" | "mixed" | null;
  payments: ISalePayment[];
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
};

export type IPurchaseDocument = Document & {
  purchaseNumber: string;
  branchId: mongoose.Types.ObjectId;
  supplierId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
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
  branchId: mongoose.Types.ObjectId | null;
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

export type ISaleReturnDocument = Document & {
  returnNumber: string;
  saleId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId | null;
  customerId: mongoose.Types.ObjectId | null;
  userId: mongoose.Types.ObjectId;
  status: "pending" | "approved" | "rejected";
  items: ISaleItemSnapshot[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  refundMethod: "cash" | "original" | "credit";
  reason: string;
  note: string;
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
  /** Free-text category used for storefront filtering (not the POS category tree). */
  category: string;
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
    taxRate: { type: Number, default: 0 },
  },
  { timestamps: true }
);

BranchSchema.index({ code: 1 }, { unique: true });

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
    description: { type: String, default: "" },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", default: null },
    costPrice: { type: Number, default: 0, min: 0 },
    sellingPrice: { type: Number, default: 0, min: 0 },
    discountPrice: { type: Number, default: 0, min: 0 },
    taxRate: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    reorderPoint: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["active", "inactive", "archived"], default: "active" },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
  },
  { timestamps: true }
);

ProductSchema.index({ sku: 1 }, { unique: true, sparse: true });
ProductSchema.index({ barcode: 1 }, { unique: true, sparse: true });
ProductSchema.index({ categoryId: 1 });
ProductSchema.index({ brandId: 1 });
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
    movementType: {
      type: String,
      enum: ["PURCHASE_IN", "SALE_OUT", "CUSTOMER_RETURN_IN", "SUPPLIER_RETURN_OUT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "STOCK_COUNT_IN", "STOCK_COUNT_OUT"],
      required: true,
    },
    quantity: { type: Number, required: true },
    unitCost: { type: Number, default: 0, min: 0 },
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
InventoryMovementSchema.index({ productId: 1, branchId: 1, createdAt: -1 });
InventoryMovementSchema.index({ referenceType: 1, referenceId: 1 });

export const SaleSchema = new Schema<ISaleDocument>(
  {
    invoiceNumber: { type: String, required: true, trim: true },
    clientTransactionId: { type: String, default: null, trim: true },
    deviceId: { type: String, default: null, trim: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
    cashierId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["completed", "canceled", "held"],
      default: "completed",
    },
    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
        name: { type: String, required: true },
        sku: { type: String, required: true },
        quantity: { type: Number, required: true, min: 0 },
        sellingPrice: { type: Number, required: true, min: 0 },
        costPrice: { type: Number, required: true, min: 0 },
        discount: { type: Number, default: 0, min: 0 },
        tax: { type: Number, default: 0, min: 0 },
        subtotal: { type: Number, required: true, min: 0 },
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
      enum: ["cash", "card", "transfer", "credit", "mixed", null],
      default: null,
    },
    payments: [
      {
        method: { type: String, enum: ["cash", "card", "transfer", "credit"], required: true },
        amount: { type: Number, required: true, min: 0 },
        reference: { type: String, default: "" },
      },
    ],
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
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
        name: { type: String, required: true },
        sku: { type: String, required: true },
        quantity: { type: Number, required: true, min: 0 },
        sellingPrice: { type: Number, required: true, min: 0 },
        costPrice: { type: Number, required: true, min: 0 },
        discount: { type: Number, default: 0, min: 0 },
        tax: { type: Number, default: 0, min: 0 },
        subtotal: { type: Number, required: true, min: 0 },
      },
    ],
    subtotal: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    refundMethod: { type: String, enum: ["cash", "original", "credit"], default: "cash" },
    reason: { type: String, default: "", trim: true },
    note: { type: String, default: "" },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SaleReturnSchema.index({ saleId: 1 });
SaleReturnSchema.index({ branchId: 1, createdAt: -1 });
SaleReturnSchema.index({ status: 1 });

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
    stock: { type: Number, default: 0, min: 0 },
    featured: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

StoreProductSchema.index({ slug: 1 }, { unique: true });
StoreProductSchema.index({ status: 1, createdAt: -1 });
StoreProductSchema.index({ category: 1 });

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
export const Category = getModel<ICategoryDocument>("Category", CategorySchema);
export const Brand = getModel<IBrandDocument>("Brand", BrandSchema);
export const Product = getModel<IProductDocument>("Product", ProductSchema);
export const InventoryMovement = getModel<IInventoryMovementDocument>("InventoryMovement", InventoryMovementSchema);
export const Sale = getModel<ISaleDocument>("Sale", SaleSchema);
export const Purchase = getModel<IPurchaseDocument>("Purchase", PurchaseSchema);
export const Customer = getModel<ICustomerDocument>("Customer", CustomerSchema);
export const Supplier = getModel<ISupplierDocument>("Supplier", SupplierSchema);
export const CustomerTransaction = getModel<ICustomerTransactionDocument>("CustomerTransaction", CustomerTransactionSchema);
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
