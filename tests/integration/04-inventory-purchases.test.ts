/**
 * Areas 4 + 5 — Inventory movements, sales deductions, adjustments, insufficient
 * stock; supplier purchases with partial payments and outstanding balances.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  api,
  authFor,
  connectDb,
  createProduct,
  createSupplier,
  dbStock,
  openRegister,
  purgeTag,
  receiveStock,
  tag,
  type AuthCtx,
} from "../helpers/qa";
import { InventoryMovement, Purchase, SupplierTransaction } from "../../src/models";

describe("inventory & purchases", () => {
  let admin: AuthCtx;
  const cleanupTags: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
  });

  afterAll(async () => {
    for (const t of cleanupTags) await purgeTag(t).catch(() => undefined);
  });

  // ---------------------------------------------------------------------------
  // Inventory adjustments
  // ---------------------------------------------------------------------------

  it("records ADJUSTMENT_IN / ADJUSTMENT_OUT movements and derives stock", async () => {
    const product = await createProduct(admin.token);
    cleanupTags.push(product.tag);

    const inc = await api(admin.token).post("/api/inventory", {
      productId: product._id, quantity: 7, movementType: "ADJUSTMENT_IN", reason: "stock count",
    });
    expect(inc.status).toBe(201);
    expect(await dbStock(product._id)).toBe(7);

    const dec = await api(admin.token).post("/api/inventory", {
      productId: product._id, quantity: 2, movementType: "ADJUSTMENT_OUT", reason: "damaged",
    });
    expect(dec.status).toBe(201);
    expect(await dbStock(product._id)).toBe(5);
  });

  it("validates adjustment payloads (missing fields, invalid type, unknown product)", async () => {
    const product = await createProduct(admin.token);
    cleanupTags.push(product.tag);

    const missing = await api(admin.token).post("/api/inventory", { productId: product._id });
    expect(missing.status).toBe(400);

    const badType = await api(admin.token).post("/api/inventory", {
      productId: product._id, quantity: 1, movementType: "NOPE", reason: "x",
    });
    expect(badType.status).toBe(400);
    expect(badType.body.error.message).toMatch(/movement type/i);

    const unknown = await api(admin.token).post("/api/inventory", {
      productId: "000000000000000000000000", quantity: 1, movementType: "ADJUSTMENT_IN", reason: "x",
    });
    expect(unknown.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Purchases → stock receipts + supplier balances
  // ---------------------------------------------------------------------------

  it("a purchase receipt adds stock (PURCHASE_IN) and records the supplier liability", async () => {
    const supplier = await createSupplier(admin.token);
    const product = await createProduct(admin.token, { purchasePrice: 10 });
    cleanupTags.push(supplier.tag, product.tag);

    const purchase = await receiveStock(admin.token, {
      supplierId: supplier._id, productId: product._id, quantity: 10, purchasePrice: 10, paidAmount: 4, paymentMethod: "transfer",
    });

    expect(await dbStock(product._id)).toBe(10);
    expect(purchase.total).toBe(100);
    expect(purchase.dueAmount).toBe(96);

    const movement = await InventoryMovement.findOne({ referenceId: purchase._id, movementType: "PURCHASE_IN" }).lean();
    expect(movement).toBeTruthy();
    expect(movement?.quantity).toBe(10);

    // Outstanding supplier balance equals the unpaid remainder.
    const txs = await SupplierTransaction.aggregate([
      { $match: { supplierId: (await import("mongoose")).default.Types.ObjectId.createFromHexString(supplier._id) } },
      { $group: { _id: null, balance: { $sum: "$amount" } } },
    ]);
    expect(txs[0]?.balance).toBe(96);
  });

  it("completes a pending purchase exactly once", async () => {
    const supplier = await createSupplier(admin.token);
    const product = await createProduct(admin.token);
    cleanupTags.push(supplier.tag, product.tag);
    const purchase = await receiveStock(admin.token, { supplierId: supplier._id, productId: product._id, quantity: 2, paidAmount: 0 });

    const first = await api(admin.token).post("/api/purchases", { action: "complete", id: purchase._id });
    expect(first.status).toBe(200);
    expect(first.body.data.purchase.status).toBe("completed");

    const second = await api(admin.token).post("/api/purchases", { action: "complete", id: purchase._id });
    expect(second.status).toBe(400);
    expect(second.body.error.message).toMatch(/not pending/i);
  });

  it("records supplier payments, allocates them to purchases, and blocks overpayment", async () => {
    const supplier = await createSupplier(admin.token);
    const product = await createProduct(admin.token);
    cleanupTags.push(supplier.tag, product.tag);

    const purchase = await receiveStock(admin.token, {
      supplierId: supplier._id, productId: product._id, quantity: 5, purchasePrice: 20, paidAmount: 0,
    });
    expect(purchase.dueAmount).toBe(100);

    const over = await api(admin.token).post("/api/finance/supplier-payments", {
      supplierId: supplier._id, amount: 500, method: "transfer",
    });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/exceeds the payable balance/i);

    const paid = await api(admin.token).post("/api/finance/supplier-payments", {
      supplierId: supplier._id, amount: 60, method: "transfer", reference: "qa-ref",
    });
    expect(paid.status).toBe(201);
    expect(paid.body.data.balanceAfter).toBe(40);

    // Payment is allocated to the oldest open purchase.
    const reread = await Purchase.findById(purchase._id).lean();
    expect(reread?.dueAmount).toBe(40);

    // Payment history is queryable.
    const history = await api(admin.token).get(`/api/finance/supplier-payments?supplierId=${supplier._id}`);
    expect(history.status).toBe(200);
    expect(history.body.total).toBeGreaterThanOrEqual(1);
    expect(history.body.summary.totalAmount).toBeGreaterThanOrEqual(60);
  });

  it("exposes each supplier's outstanding payable in the list (withBalance=1)", async () => {
    const supplier = await createSupplier(admin.token);
    const untouched = await createSupplier(admin.token);
    const product = await createProduct(admin.token);
    cleanupTags.push(supplier.tag, untouched.tag, product.tag);

    // Unpaid purchase → payable 100; then a partial payment of 30 → payable 70.
    await receiveStock(admin.token, {
      supplierId: supplier._id, productId: product._id, quantity: 5, purchasePrice: 20, paidAmount: 0,
    });
    const paid = await api(admin.token).post("/api/finance/supplier-payments", {
      supplierId: supplier._id, amount: 30, method: "transfer",
    });
    expect(paid.status).toBe(201);

    const list = await api(admin.token).get("/api/suppliers?all=1&withBalance=1");
    expect(list.status).toBe(200);
    const row = list.body.find((s: any) => s._id === supplier._id);
    const zeroRow = list.body.find((s: any) => s._id === untouched._id);
    expect(row?.balance).toBe(70);
    // A supplier with no ledger movement must report a real zero, not undefined.
    expect(zeroRow?.balance).toBe(0);
  });

  it("cancels a pending purchase and backs the stock out", async () => {
    const supplier = await createSupplier(admin.token);
    const product = await createProduct(admin.token);
    cleanupTags.push(supplier.tag, product.tag);

    const purchase = await receiveStock(admin.token, { supplierId: supplier._id, productId: product._id, quantity: 4, paidAmount: 0 });
    expect(await dbStock(product._id)).toBe(4);

    const cancel = await api(admin.token).post("/api/purchases", { action: "cancel", id: purchase._id });
    expect(cancel.status).toBe(200);
    expect(await dbStock(product._id)).toBe(0);

    const reread = await Purchase.findById(purchase._id).lean();
    expect(reread?.status).toBe("canceled");
  });

  // ---------------------------------------------------------------------------
  // Sales deduction + insufficient stock
  // ---------------------------------------------------------------------------

  it("a completed sale deducts stock exactly once (persisted movements)", async () => {
    const product = await createProduct(admin.token, { sellingPrice: 25 });
    cleanupTags.push(product.tag);
    await api(admin.token).post("/api/inventory", { productId: product._id, quantity: 10, movementType: "ADJUSTMENT_IN", reason: "seed" });
    const registerId = await openRegister(admin.token, 100);

    const sale = await api(admin.token).post("/api/sales", {
      items: [{ productId: product._id, quantity: 3 }],
      payments: [{ method: "card", amount: 75 }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.data.total).toBe(75);
    expect(await dbStock(product._id)).toBe(7);

    const saleOut = await InventoryMovement.find({ referenceId: sale.body.data.id, movementType: "SALE_OUT" }).lean();
    expect(saleOut).toHaveLength(1);
    expect(saleOut[0].quantity).toBe(3);
    expect(registerId).toBeTruthy();
  });

  it("refuses a sale beyond available stock with INSUFFICIENT_STOCK and does not mutate stock", async () => {
    const product = await createProduct(admin.token);
    cleanupTags.push(product.tag);
    await api(admin.token).post("/api/inventory", { productId: product._id, quantity: 2, movementType: "ADJUSTMENT_IN", reason: "seed" });

    const res = await api(admin.token).post("/api/sales", {
      items: [{ productId: product._id, quantity: 3 }],
      payments: [{ method: "card", amount: 60 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await dbStock(product._id)).toBe(2);
  });

  it("refuses a cash sale with no open register (NO_OPEN_REGISTER) but allows card sales", async () => {
    // Test files do not run in filename order — close any register the cashier
    // may have opened in another file so the precondition is deterministic.
    const cashier = await authFor(ACCOUNTS.cashier);
    const current = await api(cashier.token).get("/api/cash-register");
    if (current.body.session) {
      const closed = await api(cashier.token).post("/api/cash-register", {
        action: "close",
        registerId: current.body.session._id,
        countedCash: current.body.summary?.expectedCash ?? 0,
      });
      expect(closed.status).toBe(200);
    }
    expect((await api(cashier.token).get("/api/cash-register")).body.session).toBeNull();

    const product = await createProduct(admin.token, { sellingPrice: 30 });
    cleanupTags.push(product.tag);
    await api(admin.token).post("/api/inventory", { productId: product._id, quantity: 5, movementType: "ADJUSTMENT_IN", reason: "seed" });

    const cash = await api(cashier.token).post("/api/sales", {
      items: [{ productId: product._id, quantity: 1 }],
      payments: [{ method: "cash", amount: 30 }],
    });
    expect(cash.status).toBe(400);
    expect(cash.body.error.code).toBe("NO_OPEN_REGISTER");
    expect(await dbStock(product._id)).toBe(5);

    const card = await api(cashier.token).post("/api/sales", {
      items: [{ productId: product._id, quantity: 1 }],
      payments: [{ method: "card", amount: 30 }],
    });
    expect(card.status).toBe(201);
    expect(await dbStock(product._id)).toBe(4);
  });

  it("rejects unknown products and zero quantities with 400", async () => {
    const unknown = await api(admin.token).post("/api/sales", {
      items: [{ productId: "000000000000000000000000", quantity: 1 }],
      payments: [{ method: "card", amount: 10 }],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("PRODUCT_NOT_FOUND");

    const product = await createProduct(admin.token);
    cleanupTags.push(product.tag);
    const zero = await api(admin.token).post("/api/sales", {
      items: [{ productId: product._id, quantity: 0 }],
      payments: [{ method: "card", amount: 10 }],
    });
    expect(zero.status).toBe(400);
  });
});
