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

  // Purchases
  { name: "purchases.view", description: "View purchases", category: "Purchases" },
  { name: "purchases.create", description: "Create purchases", category: "Purchases" },
  { name: "purchases.update", description: "Update purchases", category: "Purchases" },
  { name: "purchases.cancel", description: "Cancel purchases", category: "Purchases" },

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

    // Purchases
    "purchases.view",
    "purchases.create",
    "purchases.update",
    "purchases.cancel",

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
    "sales.view",
    "sales.create",
    "sales.cancel",
    "sales.refund",
    "customers.view",
    "customers.payment",
    "cash_register.view",
    "cash_register.open",
    "cash_register.close",
  ],

  InventoryManager: [
    "dashboard.view",
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
