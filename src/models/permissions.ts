import mongoose from "mongoose";
import { Role, Permission, User } from "@/models";

export const ALL_PERMISSIONS = [
  // Dashboard
  { name: "dashboard.view", description: "View dashboard", category: "Dashboard" },

  // Products
  { name: "products.view", description: "View products", category: "Products" },
  { name: "products.create", description: "Create products", category: "Products" },
  { name: "products.update", description: "Update products", category: "Products" },
  { name: "products.delete", description: "Delete products", category: "Products" },

  // Categories
  { name: "categories.view", description: "View categories", category: "Categories" },
  { name: "categories.create", description: "Create categories", category: "Categories" },
  { name: "categories.update", description: "Update categories", category: "Categories" },
  { name: "categories.delete", description: "Delete categories", category: "Categories" },

  // Brands
  { name: "brands.view", description: "View brands", category: "Brands" },
  { name: "brands.create", description: "Create brands", category: "Brands" },
  { name: "brands.update", description: "Update brands", category: "Brands" },
  { name: "brands.delete", description: "Delete brands", category: "Brands" },

  // Inventory
  { name: "inventory.view", description: "View inventory", category: "Inventory" },
  { name: "inventory.adjust", description: "Adjust inventory", category: "Inventory" },
  { name: "inventory.count", description: "Perform inventory counts", category: "Inventory" },

  // Sales
  { name: "sales.view", description: "View sales", category: "Sales" },
  { name: "sales.create", description: "Create sales", category: "Sales" },
  { name: "sales.cancel", description: "Cancel sales", category: "Sales" },
  { name: "sales.refund", description: "Process refunds", category: "Sales" },
  { name: "sales.discount", description: "Apply discounts to sales", category: "Sales" },
  { name: "sales.wholesale", description: "Apply wholesale price tiers at POS", category: "Sales" },
  { name: "sales.override_expired", description: "Sell expired stock with a logged override", category: "Sales" },

  // Departments
  { name: "departments.view", description: "View departments", category: "Departments" },
  { name: "departments.create", description: "Create departments", category: "Departments" },
  { name: "departments.update", description: "Update departments and assignments", category: "Departments" },
  { name: "departments.deactivate", description: "Deactivate departments", category: "Departments" },

  // Attendance & payroll
  { name: "attendance.view", description: "View attendance records", category: "Payroll" },
  { name: "attendance.manage", description: "Mark and correct attendance", category: "Payroll" },
  { name: "payroll.view", description: "View salary configuration and payroll", category: "Payroll" },
  { name: "payroll.manage", description: "Configure salaries and finalize payroll", category: "Payroll" },

  // Purchases
  { name: "purchases.view", description: "View purchases", category: "Purchases" },
  { name: "purchases.import", description: "Record Import (China) purchases", category: "Purchases" },
  { name: "purchases.create", description: "Create purchases", category: "Purchases" },
  { name: "purchases.update", description: "Update purchases", category: "Purchases" },
  { name: "purchases.cancel", description: "Cancel purchases", category: "Purchases" },

  // Customer loyalty bonus
  { name: "bonus.view", description: "View customer bonus balances and ledger", category: "Bonus" },
  { name: "bonus.redeem", description: "Redeem customer bonus at POS", category: "Bonus" },
  { name: "bonus.configure", description: "Configure customer bonus rules and rates", category: "Bonus" },
  { name: "bonus.adjust", description: "Manually adjust a customer's bonus balance", category: "Bonus" },
  { name: "bonus.reports", description: "View customer bonus reports", category: "Bonus" },

  // Employee purchases
  { name: "employee_purchases.view", description: "View employee purchases and balances", category: "Employee Purchases" },
  { name: "employee_purchases.process", description: "Process purchases on behalf of an employee", category: "Employee Purchases" },
  { name: "employee_purchases.apply_benefit", description: "Apply the employee purchase benefit", category: "Employee Purchases" },
  { name: "employee_purchases.pay", description: "Record employee purchase payments", category: "Employee Purchases" },
  { name: "employee_purchases.approve_credit", description: "Approve employee purchases on credit", category: "Employee Purchases" },
  { name: "employee_purchases.approve_deduction", description: "Approve or exclude payroll deductions", category: "Employee Purchases" },
  { name: "employee_purchases.configure", description: "Configure employee benefit rates and limits", category: "Employee Purchases" },
  { name: "employee_purchases.reports", description: "View employee purchase reports", category: "Employee Purchases" },

  // Customers
  { name: "customers.view", description: "View customers", category: "Customers" },
  { name: "customers.create", description: "Create customers", category: "Customers" },
  { name: "customers.update", description: "Update customers", category: "Customers" },
  { name: "customers.delete", description: "Delete customers", category: "Customers" },
  { name: "customers.payment", description: "Record customer payments", category: "Customers" },

  // Suppliers
  { name: "suppliers.view", description: "View suppliers", category: "Suppliers" },
  { name: "suppliers.create", description: "Create suppliers", category: "Suppliers" },
  { name: "suppliers.update", description: "Update suppliers", category: "Suppliers" },
  { name: "suppliers.delete", description: "Delete suppliers", category: "Suppliers" },
  { name: "suppliers.payment", description: "Record supplier payments", category: "Suppliers" },

  // Expenses
  { name: "expenses.view", description: "View expenses", category: "Expenses" },
  { name: "expenses.create", description: "Create expenses", category: "Expenses" },
  { name: "expenses.update", description: "Update expenses", category: "Expenses" },
  { name: "expenses.delete", description: "Delete expenses", category: "Expenses" },

  // Cash Register
  { name: "cash_register.view", description: "View cash register", category: "Cash Register" },
  { name: "cash_register.open", description: "Open cash register", category: "Cash Register" },
  { name: "cash_register.close", description: "Close cash register", category: "Cash Register" },

  // Reports
  { name: "reports.sales", description: "View sales reports", category: "Reports" },
  { name: "reports.products", description: "View product reports", category: "Reports" },
  { name: "reports.inventory", description: "View inventory reports", category: "Reports" },
  { name: "reports.purchases", description: "View purchase reports", category: "Reports" },
  { name: "reports.profit", description: "View profit reports", category: "Reports" },
  { name: "reports.finance", description: "View finance reports", category: "Reports" },
  { name: "reports.store", description: "View online store reports", category: "Reports" },
  { name: "reports.departments", description: "View department sales and profit reports", category: "Reports" },

  // Warehouse / stock transfers
  { name: "transfers.view", description: "View stock transfers", category: "Warehouse" },
  { name: "transfers.create", description: "Create stock transfers", category: "Warehouse" },
  { name: "transfers.dispatch", description: "Dispatch stock transfers", category: "Warehouse" },
  { name: "transfers.receive", description: "Receive stock transfers", category: "Warehouse" },
  { name: "transfers.cancel", description: "Cancel stock transfers", category: "Warehouse" },

  // Online Store (public ecommerce storefront)
  { name: "store.view", description: "View online store products", category: "Online Store" },
  { name: "store.manage", description: "Add and edit online store products", category: "Online Store" },
  { name: "store.orders", description: "Manage online store orders", category: "Online Store" },

  // Users & Access
  { name: "users.view", description: "View users", category: "Users & Access" },
  { name: "users.create", description: "Create users", category: "Users & Access" },
  { name: "users.update", description: "Update users", category: "Users & Access" },
  { name: "users.delete", description: "Delete users", category: "Users & Access" },

  // Roles
  { name: "roles.view", description: "View roles", category: "Roles" },
  { name: "roles.manage", description: "Manage roles and permissions", category: "Roles" },

  // Settings
  { name: "settings.view", description: "View settings", category: "Settings" },
  { name: "settings.manage", description: "Manage settings", category: "Settings" },

  // Audit
  { name: "audit_logs.view", description: "View audit logs", category: "Audit Logs" },
];

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  SuperAdmin: ALL_PERMISSIONS.map((p) => p.name),

  Manager: [
    // Dashboard
    "dashboard.view",

    // Products
    "products.view",
    "products.create",
    "products.update",
    "products.delete",

    // Categories
    "categories.view",
    "categories.create",
    "categories.update",
    "categories.delete",

    // Brands
    "brands.view",
    "brands.create",
    "brands.update",
    "brands.delete",

    // Departments
    "departments.view",
    "departments.create",
    "departments.update",
    "departments.deactivate",

    // Attendance & payroll
    "attendance.view",
    "attendance.manage",
    "payroll.view",
    "payroll.manage",

    // Warehouse
    "transfers.view",
    "transfers.create",
    "transfers.dispatch",
    "transfers.receive",
    "transfers.cancel",

    // Inventory
    "inventory.view",
    "inventory.adjust",
    "inventory.count",

    // Sales
    "sales.view",
    "sales.create",
    "sales.cancel",
    "sales.refund",
    "sales.discount",
    "sales.wholesale",
    "sales.override_expired",

    // Purchases
    "purchases.view",
    "purchases.create",
    "purchases.import",
    "purchases.update",
    "purchases.cancel",

    // Customer bonus
    "bonus.view",
    "bonus.redeem",
    "bonus.configure",
    "bonus.adjust",
    "bonus.reports",

    // Employee purchases
    "employee_purchases.view",
    "employee_purchases.process",
    "employee_purchases.apply_benefit",
    "employee_purchases.pay",
    "employee_purchases.approve_credit",
    "employee_purchases.approve_deduction",
    "employee_purchases.configure",
    "employee_purchases.reports",

    // Customers
    "customers.view",
    "customers.create",
    "customers.update",
    "customers.delete",
    "customers.payment",

    // Suppliers
    "suppliers.view",
    "suppliers.create",
    "suppliers.update",
    "suppliers.delete",
    "suppliers.payment",

    // Expenses
    "expenses.view",
    "expenses.create",
    "expenses.update",
    "expenses.delete",

    // Cash Register
    "cash_register.view",
    "cash_register.open",
    "cash_register.close",

    // Reports
    "reports.sales",
    "reports.products",
    "reports.inventory",
    "reports.purchases",
    "reports.profit",
    "reports.finance",
    "reports.store",
    "reports.departments",

    // Online Store
    "store.view",
    "store.manage",
    "store.orders",

    // Users & Access
    "users.view",
    "users.create",
    "users.update",
    "users.delete",

    // Roles
    "roles.view",
    "roles.manage",

    // Settings
    "settings.view",
    "settings.manage",

    // Audit
    "audit_logs.view",
  ],

  Cashier: [
    "dashboard.view",
    "products.view",
    "departments.view",
    "sales.view",
    "sales.create",
    "sales.cancel",
    "sales.refund",
    "sales.discount",
    "bonus.view",
    "bonus.redeem",
    "employee_purchases.process",
    "employee_purchases.apply_benefit",
    "employee_purchases.view",
    "customers.view",
    "customers.payment",
    "cash_register.view",
    "cash_register.open",
    "cash_register.close",
  ],

  InventoryManager: [
    "dashboard.view",
    "departments.view",
    "transfers.view",
    "transfers.create",
    "transfers.dispatch",
    "transfers.receive",
    "transfers.cancel",
    "products.view",
    "products.create",
    "products.update",
    "products.delete",
    "categories.view",
    "categories.create",
    "categories.update",
    "categories.delete",
    "inventory.view",
    "inventory.adjust",
    "inventory.count",
    "suppliers.view",
    "suppliers.create",
    "suppliers.update",
    "suppliers.delete",
    "purchases.view",
    "purchases.create",
    "purchases.update",
    "purchases.cancel",
    "reports.inventory",
  ],

  Accountant: [
    "dashboard.view",
    "departments.view",
    "attendance.view",
    "payroll.view",
    "bonus.view",
    "bonus.adjust",
    "bonus.reports",
    "employee_purchases.view",
    "employee_purchases.pay",
    "employee_purchases.approve_deduction",
    "employee_purchases.reports",
    "reports.departments",
    "purchases.view",
    "purchases.create",
    "purchases.update",
    "purchases.cancel",
    "customers.view",
    "customers.payment",
    "suppliers.view",
    "suppliers.payment",
    "expenses.view",
    "expenses.create",
    "expenses.update",
    "expenses.delete",
    "cash_register.view",
    "cash_register.open",
    "cash_register.close",
    "reports.sales",
    "reports.purchases",
    "reports.profit",
    "reports.finance",
    "reports.store",
    "store.view",
    "store.orders",
  ],
};

export async function seedPermissions() {
  // Upsert by name so databases seeded by an older build pick up newly
  // added permissions (e.g. brands.*) instead of silently skipping.
  for (const p of ALL_PERMISSIONS) {
    await Permission.updateOne({ name: p.name }, { $setOnInsert: { ...p } }, { upsert: true });
  }
}

export async function seedRoles() {
  await seedPermissions();

  const permissions = await Permission.find({}).lean() as Array<{ _id: unknown; name: string }>;
  const permissionMap = new Map<string, unknown>(permissions.map((p) => [p.name, p._id]));

  for (const [roleName, permNames] of Object.entries(ROLE_PERMISSIONS)) {
    const permIds = permNames
      .map((n) => permissionMap.get(n))
      .filter((id): id is mongoose.Types.ObjectId => Boolean(id));

    const existing = await Role.findOne({ name: roleName });
    if (!existing) {
      await Role.create({ name: roleName, description: "", isSystem: true, permissions: permIds });
      continue;
    }

    // Top up system roles with any permissions added to the catalog since
    // they were first seeded. Custom (non-system) roles are user-managed
    // and left untouched.
    if (existing.isSystem) {
      const current = new Set((existing.permissions ?? []).map((id) => String(id)));
      const missing = permIds.filter((id) => !current.has(String(id)));
      if (missing.length > 0) {
        await Role.updateOne({ _id: existing._id }, { $addToSet: { permissions: { $each: missing } } });
      }
    }
  }
}
