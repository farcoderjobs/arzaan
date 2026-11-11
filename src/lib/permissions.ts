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
  discounts: {
    view: "discounts.view",
    manage: "discounts.manage",
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
    wholesale: "sales.wholesale",
    overrideExpired: "sales.override_expired",
  },
  departments: {
    view: "departments.view",
    create: "departments.create",
    update: "departments.update",
    deactivate: "departments.deactivate",
  },
  attendance: {
    view: "attendance.view",
    manage: "attendance.manage",
  },
  payroll: {
    view: "payroll.view",
    manage: "payroll.manage",
  },
  transfers: {
    view: "transfers.view",
    create: "transfers.create",
    dispatch: "transfers.dispatch",
    receive: "transfers.receive",
    cancel: "transfers.cancel",
  },
  purchases: {
    view: "purchases.view",
    create: "purchases.create",
    importStock: "purchases.import",
    update: "purchases.update",
    cancel: "purchases.cancel",
  },
  bonus: {
    view: "bonus.view",
    redeem: "bonus.redeem",
    configure: "bonus.configure",
    adjust: "bonus.adjust",
    reports: "bonus.reports",
  },
  employeePurchases: {
    view: "employee_purchases.view",
    process: "employee_purchases.process",
    applyBenefit: "employee_purchases.apply_benefit",
    pay: "employee_purchases.pay",
    approveCredit: "employee_purchases.approve_credit",
    approveDeduction: "employee_purchases.approve_deduction",
    configure: "employee_purchases.configure",
    reports: "employee_purchases.reports",
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
    departments: "reports.departments",
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
