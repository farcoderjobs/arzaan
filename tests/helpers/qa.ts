/**
 * Shared QA harness for integration tests.
 *
 * - Talks to the QA dev server over HTTP (scripts/qa-server.mjs).
 * - Reads/writes the dedicated *-test MongoDB database directly for state
 *   assertions and test-owned cleanup. Connecting to anything but a database
 *   whose name ends in "-test" is refused.
 * - Mints access tokens with the application's own JWT secret so tests do not
 *   depend on the login UI (login itself is covered by the e2e suite).
 */
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import {
  Product,
  Category,
  Supplier,
  Customer,
  Sale,
  Purchase,
  InventoryMovement,
  SupplierTransaction,
  CustomerTransaction,
  CashTransaction,
  CashRegister,
  SaleReturn,
  Expense,
  Payment,
  User,
} from "../../src/models";

export const BASE_URL = (process.env.QA_BASE_URL ?? "http://localhost:3210").replace(/\/+$/, "");
export const QA_PASSWORD = process.env.QA_USER_PASSWORD ?? "qa-test-pass-123!";

/** Seeded by scripts/seed-test-db.ts. */
export const ACCOUNTS = {
  admin: "qa-admin@qa.test",
  manager: "qa-manager@qa.test",
  cashier: "qa-cashier@qa.test",
  accountant: "qa-accountant@qa.test",
  branch1: "qa-branch1@qa.test",
  branch2: "qa-branch2@qa.test",
} as const;

// ---------------------------------------------------------------------------
// Database (test-owned access only)
// ---------------------------------------------------------------------------

export function assertTestDb(): string {
  const db = process.env.MONGODB_DB_NAME ?? "";
  if (!db.endsWith("-test")) {
    throw new Error(
      `[qa] Refusing DB access: MONGODB_DB_NAME must end with "-test" (got "${db || "<unset>"}").`
    );
  }
  return db;
}

export async function connectDb(): Promise<mongoose.Connection> {
  const dbName = assertTestDb();
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI as string, {
      dbName,
      serverSelectionTimeoutMS: 20_000,
    });
  }
  return mongoose.connection;
}

const STOCK_IN_TYPES = ["PURCHASE_IN", "CUSTOMER_RETURN_IN", "ADJUSTMENT_IN", "STOCK_COUNT_IN"];

/** Source-of-truth stock: sum of inventory movements (same rule as the POS). */
export async function dbStock(productId: string, branchId?: string | null): Promise<number> {
  await connectDb();
  const match: Record<string, unknown> = { productId: new mongoose.Types.ObjectId(productId) };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);
  const rows = await InventoryMovement.aggregate<{ stock: number }>([
    { $match: match },
    {
      $group: {
        _id: null,
        stock: {
          $sum: {
            $cond: [{ $in: ["$movementType", STOCK_IN_TYPES] }, "$quantity", { $multiply: ["$quantity", -1] }],
          },
        },
      },
    },
  ]);
  return rows[0]?.stock ?? 0;
}

// ---------------------------------------------------------------------------
// Auth: token minting + API client
// ---------------------------------------------------------------------------

export function mintAccessToken(userId: string, roleId: string, options?: { expiresIn?: string }): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("[qa] JWT_SECRET is not set (load .env before running tests)");
  const expiresIn = (options?.expiresIn ?? process.env.JWT_EXPIRES_IN ?? "1d") as jwt.SignOptions["expiresIn"];
  return jwt.sign({ sub: userId, role: roleId }, secret, { expiresIn });
}

export type AuthCtx = { token: string; userId: string; roleId: string };

export async function authFor(email: string): Promise<AuthCtx> {
  await connectDb();
  const user = await User.findOne({ email: email.toLowerCase() }).lean();
  if (!user) {
    // Include the actually-connected database so mis-resolved env (wrong DB
    // name) is immediately visible instead of looking like a missing seed.
    const connected = mongoose.connection.db?.databaseName ?? "<not connected>";
    throw new Error(
      `[qa] QA account ${email} not found in database "${connected}" ` +
        `(expected "${process.env.MONGODB_DB_NAME}") — the test DB needs seeding (scripts/seed-test-db.ts) ` + `or the harness is pointed at the wrong database.`
    );
  }
  return {
    token: mintAccessToken(String(user._id), String(user.roleId)),
    userId: String(user._id),
    roleId: String(user.roleId),
  };
}

export type ApiResponse<T = any> = { status: number; body: T };

export function api(token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.cookie = `pos_access_token=${token}`;

  async function call<T = any>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    let json: any = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    return { status: res.status, body: json };
  }

  return {
    get: <T = any>(path: string) => call<T>("GET", path),
    post: <T = any>(path: string, body?: unknown) => call<T>("POST", path, body),
    put: <T = any>(path: string, body?: unknown) => call<T>("PUT", path, body),
    patch: <T = any>(path: string, body?: unknown) => call<T>("PATCH", path, body),
    del: <T = any>(path: string, body?: unknown) => call<T>("DELETE", path, body),
  };
}

// ---------------------------------------------------------------------------
// Fixtures — unique, tag-prefixed so cleanup can never touch foreign data
// ---------------------------------------------------------------------------

let seq = 0;
export function tag(prefix = "qa"): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export async function createCategory(token: string, name?: string) {
  const t = tag("cat");
  const res = await api(token).post("/api/categories", { name: name ?? `QA Category ${t}` });
  if (res.status !== 201) throw new Error(`createCategory failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.category as { _id: string; name: string };
}

export async function createProduct(
  token: string,
  overrides: Record<string, unknown> = {}
): Promise<{ _id: string; name: string; sku: string; barcode: string; sellingPrice: number; costPrice: number; tag: string }> {
  const t = (overrides.tag as string) ?? tag("prod");
  const body = {
    name: `QA Product ${t}`,
    sku: `SK${t}`.toUpperCase().slice(0, 48),
    barcode: `BC${Date.now()}${Math.floor(Math.random() * 10000)}`,
    purchasePrice: 10,
    sellingPrice: 20,
    // 0 = no wholesale discount: the app prices every line at `discountPrice`
    // whenever it is > 0 and lower than sellingPrice (see computeSaleTotals),
    // so tests that care about totals must opt in explicitly.
    wholesalePrice: 0,
    tax: 0,
    discount: 0,
    minimumStock: 0,
    description: "",
    status: "active",
    ...overrides,
    tag: undefined,
  };
  const res = await api(token).post("/api/products", body);
  if (res.status !== 201) throw new Error(`createProduct failed: ${res.status} ${JSON.stringify(res.body)}`);
  const p = res.body.data.product;
  return { ...p, barcode: p.barcode ?? "", tag: t };
}

export async function createSupplier(token: string, overrides: Record<string, unknown> = {}) {
  const t = tag("sup");
  const res = await api(token).post("/api/suppliers", {
    name: `QA Supplier ${t}`,
    phone: `07${Math.floor(Math.random() * 100000000)}`,
    email: "",
    address: "",
    notes: t,
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`createSupplier failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body.data.supplier, tag: t } as { _id: string; name: string; tag: string };
}

export async function createCustomer(token: string, overrides: Record<string, unknown> = {}) {
  const t = tag("cust");
  const res = await api(token).post("/api/customers", {
    name: `QA Customer ${t}`,
    phone: `08${Math.floor(Math.random() * 100000000)}`,
    email: "",
    address: "",
    notes: t,
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`createCustomer failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body.data.customer, tag: t } as { _id: string; name: string; tag: string };
}

/** Records a purchase and receives its stock (movements are created on POST). */
export async function receiveStock(
  token: string,
  opts: {
    supplierId: string;
    productId: string;
    quantity: number;
    purchasePrice?: number;
    paidAmount?: number;
    paymentMethod?: "cash" | "card" | "transfer" | "check" | "account" | "other";
    note?: string;
  }
) {
  const res = await api(token).post("/api/purchases", {
    action: "create",
    supplierId: opts.supplierId,
    items: [
      {
        productId: opts.productId,
        quantity: opts.quantity,
        purchasePrice: opts.purchasePrice ?? 10,
        sellingPrice: 0,
      },
    ],
    paidAmount: opts.paidAmount ?? 0,
    paymentMethod: opts.paymentMethod ?? "transfer",
    note: opts.note ?? tag("pur"),
  });
  if (res.status !== 201) throw new Error(`receiveStock failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.purchase as { _id: string; purchaseNumber: string; total: number; dueAmount: number };
}

export async function openRegister(token: string, openCash = 0): Promise<string> {
  const res = await api(token).post("/api/cash-register", { action: "open", openCash });
  if (res.status === 201) return res.body.data.registerId as string;
  if (res.status === 400 && /already/i.test(res.body?.error?.message ?? "")) {
    const current = await api(token).get("/api/cash-register");
    if (current.body.session?._id) return current.body.session._id as string;
  }
  throw new Error(`openRegister failed: ${res.status} ${JSON.stringify(res.body)}`);
}

/** Standard checkout payload — totals are always recomputed server-side. */
export function checkoutPayload(opts: {
  items: Array<{ productId: string; quantity: number; unitDiscount?: number }>;
  customerId?: string | null;
  discount?: number;
  discountType?: "amount" | "percent";
  payments?: Array<{ method: "cash" | "card" | "transfer" | "credit"; amount: number; reference?: string }>;
  clientTransactionId?: string;
  note?: string;
  status?: "completed" | "held";
}) {
  return {
    customerId: opts.customerId ?? null,
    items: opts.items,
    discount: opts.discount ?? 0,
    discountType: opts.discountType ?? "amount",
    payments: opts.payments ?? [],
    note: opts.note ?? "",
    status: opts.status ?? "completed",
    ...(opts.clientTransactionId ? { clientTransactionId: opts.clientTransactionId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cleanup — only ever deletes documents carrying this run's unique tags
// ---------------------------------------------------------------------------

export async function purgeTag(t: string): Promise<void> {
  await connectDb();
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(escaped, "i");

  // Tagged products are the anchor: sales/purchases reference them by id even
  // when their own documents carry no tag (e.g. POS sales made in the UI).
  const taggedProducts = await Product.find({ $or: [{ name: rx }, { sku: rx }, { barcode: rx }] }).select("_id").lean();
  const productIds = taggedProducts.map((p) => p._id);

  const sales = await Sale.find({ $or: [{ note: rx }, { "items.productId": { $in: productIds } }] }).select("_id").lean();
  const saleIds = sales.map((s) => s._id);
  const purchases = await Purchase.find({ $or: [{ note: rx }, { "items.productId": { $in: productIds } }] }).select("_id").lean();
  const purchaseIds = purchases.map((p) => p._id);

  await Promise.all([
    InventoryMovement.deleteMany({
      $or: [{ referenceId: { $in: saleIds } }, { referenceId: { $in: purchaseIds } }, { productId: { $in: productIds } }, { note: rx }],
    }),
    CashTransaction.deleteMany({ $or: [{ referenceId: { $in: saleIds } }, { description: rx }] }),
    SaleReturn.deleteMany({ $or: [{ saleId: { $in: saleIds } }, { reason: rx }] }),
    CustomerTransaction.deleteMany({ $or: [{ referenceId: { $in: saleIds } }, { description: rx }] }),
    SupplierTransaction.deleteMany({ $or: [{ referenceId: { $in: purchaseIds } }, { description: rx }] }),
    Payment.deleteMany({ $or: [{ referenceId: { $in: saleIds } }, { referenceId: { $in: purchaseIds } }, { description: rx }] }),
    Sale.deleteMany({ _id: { $in: saleIds } }),
    Purchase.deleteMany({ _id: { $in: purchaseIds } }),
  ]);

  await Promise.all([
    Product.deleteMany({ _id: { $in: productIds } }),
    Category.deleteMany({ name: rx }),
    Supplier.deleteMany({ $or: [{ name: rx }, { notes: rx }] }),
    Customer.deleteMany({ $or: [{ name: rx }, { notes: rx }] }),
    Expense.deleteMany({ description: rx }),
    User.deleteMany({ email: rx }),
  ]);
}
