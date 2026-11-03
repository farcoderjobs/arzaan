import { collectionPriority } from "./collections";

/**
 * Replication policy per collection.
 *
 * The shop node is where the business happens, so the center trusts node rows —
 * but only after re-checking, server-side, that
 *
 *  1. the acting user still exists, is active, and still holds a permission the
 *     operation requires (cached client permissions are never sufficient), and
 *  2. the row is not a stale copy of reference data the center already owns
 *     (`centerAuthoritative`).
 */

export type CollectionPolicy = {
  /** Coarse label for the UI. */
  entityType: string;
  /**
   * Permissions the acting user must hold at the CENTER for this collection.
   * Any of them is enough; an empty list means "any active user".
   */
  permissions: string[];
  /** Reference data: the center wins when it has a newer version. */
  centerAuthoritative: boolean;
  /** History the center must never overwrite once written. */
  appendOnly: boolean;
  /** Never replicated (session/secret material). */
  stripFields: string[];
};

const SESSION_SECRETS = ["refreshTokenHash", "passwordResetTokenHash", "passwordResetExpires"];

export const COLLECTION_POLICY: Record<string, CollectionPolicy> = {
  roles: {
    entityType: "Role",
    permissions: ["roles.manage"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  permissions: {
    entityType: "Permission",
    permissions: ["roles.manage"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  branches: {
    entityType: "Branch",
    permissions: ["settings.manage"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  users: {
    entityType: "User",
    permissions: ["users.create", "users.update"],
    centerAuthoritative: true,
    appendOnly: false,
    // Password HASHES are replicated on purpose: a shop must be able to verify
    // an offline login without the center. Plaintext passwords and the session
    // tokens below never leave the machine that owns them.
    stripFields: SESSION_SECRETS,
  },
  departments: {
    entityType: "Department",
    permissions: ["departments.create", "departments.update"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  employeesalaries: {
    entityType: "EmployeeSalary",
    permissions: ["payroll.manage"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  storesettings: {
    entityType: "StoreSettings",
    permissions: ["settings.manage"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  categories: {
    entityType: "Category",
    permissions: ["categories.create", "categories.update"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  brands: {
    entityType: "Brand",
    permissions: ["brands.create", "brands.update"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  storeproducts: {
    entityType: "StoreProduct",
    permissions: ["store.manage"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  products: {
    entityType: "Product",
    permissions: ["products.create", "products.update"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  customers: {
    entityType: "Customer",
    permissions: ["customers.create", "customers.update"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  suppliers: {
    entityType: "Supplier",
    permissions: ["suppliers.create", "suppliers.update"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  purchases: {
    entityType: "Purchase",
    permissions: ["purchases.create", "purchases.update"],
    centerAuthoritative: false,
    appendOnly: false,
    stripFields: [],
  },
  cashregisters: {
    entityType: "CashRegister",
    permissions: ["cash_register.open", "cash_register.close"],
    centerAuthoritative: false,
    appendOnly: false,
    stripFields: [],
  },
  warehouses: {
    entityType: "Warehouse",
    permissions: ["settings.manage"],
    centerAuthoritative: true,
    appendOnly: false,
    stripFields: [],
  },
  stocktransfers: {
    entityType: "StockTransfer",
    permissions: ["transfers.create", "transfers.dispatch", "transfers.receive", "transfers.cancel"],
    centerAuthoritative: false,
    appendOnly: false,
    stripFields: [],
  },
  attendancerecords: {
    entityType: "AttendanceRecord",
    permissions: ["attendance.manage"],
    centerAuthoritative: false,
    appendOnly: false,
    stripFields: [],
  },
  payrollperiods: {
    entityType: "PayrollPeriod",
    permissions: ["payroll.manage"],
    centerAuthoritative: false,
    appendOnly: false,
    stripFields: [],
  },
  payrollentries: {
    entityType: "PayrollEntry",
    permissions: ["payroll.manage"],
    centerAuthoritative: false,
    appendOnly: false,
    stripFields: [],
  },
  inventorymovements: {
    entityType: "InventoryMovement",
    // Movements are produced by sales, returns, purchases and counts — the
    // acting user only needs to be authorized for the flow that produced it.
    permissions: [
      "inventory.adjust",
      "inventory.count",
      "sales.create",
      "sales.refund",
      "sales.cancel",
      "purchases.create",
      "purchases.cancel",
    ],
    centerAuthoritative: false,
    appendOnly: true,
    stripFields: [],
  },
  sales: {
    entityType: "Sale",
    permissions: ["sales.create", "sales.cancel"],
    centerAuthoritative: false,
    appendOnly: false,
    stripFields: [],
  },
  salereturns: {
    entityType: "SaleReturn",
    permissions: ["sales.refund", "sales.cancel"],
    centerAuthoritative: false,
    appendOnly: false,
    stripFields: [],
  },
  employeepurchases: {
    entityType: "EmployeePurchase",
    permissions: ["sales.create", "employee_purchases.process", "payroll.manage"],
    centerAuthoritative: false,
    appendOnly: false,
    stripFields: [],
  },
  employeepurchasepayments: {
    entityType: "EmployeePurchasePayment",
    permissions: ["employee_purchases.process", "employee_purchases.pay", "payroll.manage"],
    centerAuthoritative: false,
    appendOnly: true,
    stripFields: [],
  },
  employeepurchasedeductions: {
    entityType: "EmployeePurchaseDeduction",
    permissions: ["payroll.manage", "employee_purchases.approve_deduction"],
    centerAuthoritative: false,
    appendOnly: true,
    stripFields: [],
  },
  employeepurchaseledgers: {
    entityType: "EmployeePurchaseLedger",
    permissions: ["sales.create", "employee_purchases.process", "payroll.manage"],
    centerAuthoritative: false,
    appendOnly: true,
    stripFields: [],
  },
  customertransactions: {
    entityType: "CustomerTransaction",
    permissions: ["customers.payment", "sales.create", "customers.update"],
    centerAuthoritative: false,
    appendOnly: true,
    stripFields: [],
  },
  customerbonustransactions: {
    entityType: "CustomerBonusTransaction",
    permissions: ["sales.create", "customers.update"],
    centerAuthoritative: false,
    appendOnly: true,
    stripFields: [],
  },
  suppliertransactions: {
    entityType: "SupplierTransaction",
    permissions: ["suppliers.payment", "purchases.create"],
    centerAuthoritative: false,
    appendOnly: true,
    stripFields: [],
  },
  cashtransactions: {
    entityType: "CashTransaction",
    permissions: [
      "cash_register.open",
      "cash_register.close",
      "sales.create",
      "sales.refund",
      "expenses.create",
      "customers.payment",
      "suppliers.payment",
    ],
    centerAuthoritative: false,
    appendOnly: true,
    stripFields: [],
  },
  payments: {
    entityType: "Payment",
    permissions: ["customers.payment", "suppliers.payment", "sales.create", "expenses.create"],
    centerAuthoritative: false,
    appendOnly: true,
    stripFields: [],
  },
  expenses: {
    entityType: "Expense",
    permissions: ["expenses.create", "expenses.update"],
    centerAuthoritative: false,
    appendOnly: false,
    stripFields: [],
  },
  storeorders: {
    entityType: "StoreOrder",
    permissions: ["store.orders"],
    centerAuthoritative: false,
    appendOnly: false,
    stripFields: [],
  },
  auditlogs: {
    entityType: "AuditLog",
    // Audit rows are written by the server itself, so any active user is enough
    // — the permission that mattered was already enforced on the write path.
    permissions: [],
    centerAuthoritative: false,
    appendOnly: true,
    stripFields: [],
  },
};

export function policyFor(collection: string): CollectionPolicy | null {
  return COLLECTION_POLICY[collection] ?? null;
}

export function priorityFor(collection: string): number {
  return collectionPriority(collection);
}

export function isTrackedCollection(collection: string): boolean {
  return collection in COLLECTION_POLICY;
}

/** Removes fields a node must never replicate (session tokens, secrets). */
export function stripForSync(
  doc: Record<string, unknown>,
  collection: string
): Record<string, unknown> {
  const policy = policyFor(collection);
  if (!policy || policy.stripFields.length === 0) return doc;
  const out = { ...doc };
  for (const field of policy.stripFields) delete out[field];
  return out;
}
