import { connectDB, disconnectDB } from "@/lib/mongodb";
import mongoose from "mongoose";
import {
  Role,
  User,
  Branch,
  Category,
  Brand,
  Product,
  Customer,
  InventoryMovement,
} from "@/models";
import { hashPassword } from "@/utils/auth";
import { ALL_PERMISSIONS } from "@/models/permissions";

/**
 * Demo data seeder. Idempotent: skips what already exists.
 * Creates: branch, superadmin+cashier users, categories, brands,
 * products with PURCHASE_IN stock, and a few customers.
 */

async function main() {
  await connectDB();

  // ---- Branch ----
  let branch = await Branch.findOne({ code: "MAIN" });
  if (!branch) {
    branch = await Branch.create({
      name: "Main Store",
      code: "MAIN",
      address: "123 Market Street",
      phone: "+1 555 0100",
      currency: "AFN",
      taxRate: 0,
    });
    console.log("Created branch: Main Store");
  }

  // ---- Roles ----
  let superAdminRole = await Role.findOne({ name: "SuperAdmin" });
  if (!superAdminRole) {
    const permissions = await mongoose.model("Permission").find({}).select("_id");
    superAdminRole = await Role.create({
      name: "SuperAdmin",
      description: "Full access",
      isSystem: true,
      permissions: permissions.map((p) => p._id),
    });
    console.log("Created role: SuperAdmin");
  }

  let cashierRole = await Role.findOne({ name: "Cashier" });
  if (!cashierRole) {
    const cashierPermissionNames = [
      "dashboard.view",
      "products.view",
      "sales.view",
      "sales.create",
      "customers.view",
      "customers.create",
      "customers.update",
      "customers.payment",
      "cash_register.view",
    ];
    const permissions = await mongoose.model("Permission").find({ name: { $in: cashierPermissionNames } }).select("_id");
    cashierRole = await Role.create({
      name: "Cashier",
      description: "Point of sale operator",
      isSystem: true,
      permissions: permissions.map((p) => p._id),
    });
    console.log("Created role: Cashier");
  }

  // ---- Users ----
  let admin = await User.findOne({ email: "admin@pos.local" });
  if (!admin) {
    admin = await User.create({
      name: "Store Admin",
      email: "admin@pos.local",
      passwordHash: hashPassword("admin123"),
      roleId: superAdminRole._id,
      branchId: branch._id,
      status: "active",
    });
    console.log("Created user: admin@pos.local / admin123");
  }

  let cashier = await User.findOne({ email: "cashier@pos.local" });
  if (!cashier) {
    cashier = await User.create({
      name: "Casey Cashier",
      email: "cashier@pos.local",
      passwordHash: hashPassword("cashier123"),
      roleId: cashierRole._id,
      branchId: branch._id,
      status: "active",
    });
    console.log("Created user: cashier@pos.local / cashier123");
  }

  // ---- Categories & Brands ----
  const categoryNames = ["Beverages", "Snacks", "Household", "Personal Care"];
  const categories: Array<{ _id: mongoose.Types.ObjectId }> = [];
  for (const name of categoryNames) {
    let cat = await Category.findOne({ name });
    if (!cat) cat = await Category.create({ name });
    categories.push(cat as { _id: mongoose.Types.ObjectId });
  }
  if (categories.length === categoryNames.length) console.log("Categories ready");

  const brandNames = ["Acme", "FreshCo", "HomeLine"];
  const brands: Array<{ _id: mongoose.Types.ObjectId }> = [];
  for (const name of brandNames) {
    let b = await Brand.findOne({ name });
    if (!b) b = await Brand.create({ name });
    brands.push(b as { _id: mongoose.Types.ObjectId });
  }

  // ---- Products (with stock) ----
  const demoProducts = [
    { name: "Cola 500ml", sku: "BEV-001", barcode: "8901234500011", category: 0, brand: 0, costPrice: 0.55, sellingPrice: 1.25, taxRate: 5, reorderPoint: 20, stock: 120 },
    { name: "Orange Juice 1L", sku: "BEV-002", barcode: "8901234500028", category: 0, brand: 1, costPrice: 1.4, sellingPrice: 2.99, taxRate: 5, reorderPoint: 15, stock: 45 },
    { name: "Mineral Water 1.5L", sku: "BEV-003", barcode: "8901234500035", category: 0, brand: 1, costPrice: 0.3, sellingPrice: 0.9, taxRate: 0, reorderPoint: 40, stock: 200 },
    { name: "Potato Chips 150g", sku: "SNK-001", barcode: "8901234500042", category: 1, brand: 0, costPrice: 0.8, sellingPrice: 1.75, taxRate: 5, reorderPoint: 25, stock: 80 },
    { name: "Chocolate Bar", sku: "SNK-002", barcode: "8901234500059", category: 1, brand: 0, costPrice: 0.6, sellingPrice: 1.5, taxRate: 5, reorderPoint: 30, stock: 150 },
    { name: "Salted Peanuts 200g", sku: "SNK-003", barcode: "8901234500066", category: 1, brand: 1, costPrice: 1.1, sellingPrice: 2.4, taxRate: 5, reorderPoint: 20, stock: 60 },
    { name: "Dish Soap 500ml", sku: "HSE-001", barcode: "8901234500073", category: 2, brand: 2, costPrice: 1.2, sellingPrice: 2.75, taxRate: 10, reorderPoint: 15, stock: 40 },
    { name: "Laundry Powder 1kg", sku: "HSE-002", barcode: "8901234500080", category: 2, brand: 2, costPrice: 2.8, sellingPrice: 5.5, taxRate: 10, reorderPoint: 10, stock: 25 },
    { name: "Trash Bags 20pk", sku: "HSE-003", barcode: "8901234500097", category: 2, brand: 2, costPrice: 1.5, sellingPrice: 3.25, taxRate: 10, reorderPoint: 12, stock: 0 },
    { name: "Shampoo 400ml", sku: "PCE-001", barcode: "8901234500103", category: 3, brand: 2, costPrice: 2.1, sellingPrice: 4.5, taxRate: 10, reorderPoint: 12, stock: 35 },
    { name: "Toothpaste 100g", sku: "PCE-002", barcode: "8901234500110", category: 3, brand: 2, costPrice: 0.95, sellingPrice: 2.2, taxRate: 10, reorderPoint: 20, stock: 70 },
    { name: "Hand Sanitizer 250ml", sku: "PCE-003", barcode: "8901234500127", category: 3, brand: 1, costPrice: 1.3, sellingPrice: 3.0, taxRate: 10, reorderPoint: 15, stock: 50, discountPrice: 2.5 },
  ];

  let createdProducts = 0;
  for (const dp of demoProducts) {
    let product = await Product.findOne({ sku: dp.sku });
    if (!product) {
      product = await Product.create({
        name: dp.name,
        sku: dp.sku,
        barcode: dp.barcode,
        categoryId: categories[dp.category]._id,
        brandId: brands[dp.brand]._id,
        costPrice: dp.costPrice,
        sellingPrice: dp.sellingPrice,
        discountPrice: dp.discountPrice ?? 0,
        taxRate: dp.taxRate,
        reorderPoint: dp.reorderPoint,
        status: "active",
        branchId: branch._id,
      });
      createdProducts++;
    }
    const hasStock = await InventoryMovement.exists({ productId: product._id, movementType: "PURCHASE_IN" });
    if (!hasStock && dp.stock > 0) {
      await InventoryMovement.create({
        productId: product._id,
        branchId: branch._id,
        movementType: "PURCHASE_IN",
        quantity: dp.stock,
        unitCost: dp.costPrice,
        referenceType: "purchase",
        referenceId: null,
        note: "Opening stock",
        userId: admin._id,
      });
    }
  }
  console.log(`Products ready (${createdProducts} created, ${demoProducts.length} total)`);

  // ---- Customers ----
  const demoCustomers = [
    { name: "Aisha Wholesale", phone: "555-1001", email: "aisha@example.com", address: "12 Oak Ave", notes: "Wholesale buyer, net-7 terms" },
    { name: "Bilal Restaurant", phone: "555-1002", email: "bilal@example.com", address: "88 Harbor Rd", notes: "Weekly beverage order" },
    { name: "Carla Daily", phone: "555-1003", email: "carla@example.com", address: "", notes: "" },
  ];
  for (const dc of demoCustomers) {
    const exists = await Customer.findOne({ name: dc.name });
    if (!exists) {
      await Customer.create({ ...dc, status: "active", branchId: branch._id });
    }
  }
  console.log("Customers ready");

  console.log("\n=== Demo seed complete ===");
  console.log("Login: admin@pos.local / admin123 (SuperAdmin)");
  console.log("Login: cashier@pos.local / cashier123 (Cashier)");

  await disconnectDB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
