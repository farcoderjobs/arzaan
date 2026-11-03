/**
 * Replication tables shared by the model layer, the dirty-document tracker and
 * the sync worker.
 *
 * This module deliberately imports NOTHING: `src/models/index.ts` reads it while
 * defining schemas, so anything it pulled in would create an import cycle.
 *
 * `priority` is the dependency band used to order a push: reference data and
 * parents first, then stock-affecting documents, then sales, then the ledgers
 * and cash movements a sale produces.
 */

export const SYNC_COLLECTION_PRIORITY: Record<string, number> = {
  roles: 10,
  permissions: 10,
  branches: 10,
  warehouses: 10,
  users: 10,
  departments: 15,
  employeesalaries: 15,
  storesettings: 20,
  categories: 30,
  brands: 30,
  storeproducts: 35,
  products: 40,
  customers: 40,
  suppliers: 40,
  purchases: 50,
  cashregisters: 50,
  stocktransfers: 55,
  inventorymovements: 60,
  sales: 70,
  attendancerecords: 75,
  payrollperiods: 76,
  payrollentries: 77,
  salereturns: 80,
  customertransactions: 80,
  customerbonustransactions: 80,
  employeepurchases: 80,
  employeepurchasepayments: 82,
  employeepurchasedeductions: 83,
  employeepurchaseledgers: 84,
  suppliertransactions: 80,
  cashtransactions: 90,
  payments: 90,
  expenses: 90,
  storeorders: 95,
  auditlogs: 100,
};

/** Collections a node may push / pull. Anything else is refused. */
export const SYNC_TRACKED_COLLECTIONS: string[] = Object.keys(SYNC_COLLECTION_PRIORITY);

/**
 * Collections the node pulls back from the center. Transactional history is
 * push-only: the shop is where sales happen, so pulling it would only create
 * conflicts for data nobody edits at the center.
 */
export const SYNC_PULL_COLLECTIONS: string[] = [
  "roles",
  "permissions",
  "branches",
  "warehouses",
  "users",
  "departments",
  "employeesalaries",
  "storesettings",
  "categories",
  "brands",
  "storeproducts",
  "products",
  "customers",
  "suppliers",
];

export function collectionPriority(collection: string): number {
  return SYNC_COLLECTION_PRIORITY[collection] ?? 999;
}
