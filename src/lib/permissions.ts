export const PERMISSIONS = {
  dashboard: {
    view: "dashboard.view",
  },
  products: {
    view: "products.view",
    create: "products.create",
    update: "products.update",
    delete: "products.delete",
  },
  categories: {
    view: "categories.view",
    create: "categories.create",
    update: "categories.update",
    delete: "categories.delete",
  },
  brands: {
    view: "brands.view",
    create: "brands.create",
    update: "brands.update",
    delete: "brands.delete",
  },
  inventory: {
    view: "inventory.view",
    adjust: "inventory.adjust",
    count: "inventory.count",
  },
  sales: {
    view: "sales.view",
    create: "sales.create",
    cancel: "sales.cancel",
    refund: "sales.refund",
    discount: "sales.discount",
  },
  purchases: {
    view: "purchases.view",
    create: "purchases.create",
    update: "purchases.update",
    cancel: "purchases.cancel",
  },
  customers: {
    view: "customers.view",
    create: "customers.create",
    update: "customers.update",
    delete: "customers.delete",
    payment: "customers.payment",
  },
  suppliers: {
    view: "suppliers.view",
    create: "suppliers.create",
    update: "suppliers.update",
    delete: "suppliers.delete",
    payment: "suppliers.payment",
  },
  expenses: {
    view: "expenses.view",
    create: "expenses.create",
    update: "expenses.update",
    delete: "expenses.delete",
  },
  cashRegister: {
    view: "cash_register.view",
    open: "cash_register.open",
    close: "cash_register.close",
  },
  reports: {
    sales: "reports.sales",
    products: "reports.products",
    inventory: "reports.inventory",
    purchases: "reports.purchases",
    profit: "reports.profit",
    finance: "reports.finance",
    store: "reports.store",
  },
  store: {
    view: "store.view",
    manage: "store.manage",
    orders: "store.orders",
  },
  users: {
    view: "users.view",
    create: "users.create",
    update: "users.update",
    delete: "users.delete",
  },
  roles: {
    view: "roles.view",
    manage: "roles.manage",
  },
  settings: {
    view: "settings.view",
    manage: "settings.manage",
  },
  auditLogs: {
    view: "audit_logs.view",
  },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export type PermissionAction = (typeof PERMISSIONS)[PermissionKey][keyof (typeof PERMISSIONS)[PermissionKey]];

export function getPermissionValue(key: PermissionKey, action: keyof (typeof PERMISSIONS)[PermissionKey]): string {
  return PERMISSIONS[key][action];
}
