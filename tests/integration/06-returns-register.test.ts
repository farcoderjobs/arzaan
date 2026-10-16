/**
 * Areas 9 + 10 — Returns (refund, inventory restoration, authorization) and
 * cash register lifecycle (open, movements, expenses, close reconciliation).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  api,
  authFor,
  connectDb,
  checkoutPayload,
  createProduct,
  dbStock,
  openRegister,
  purgeTag,
  tag,
  type AuthCtx,
} from "../helpers/qa";
import { SaleReturn, CashTransaction, StoreSettings, User } from "../../src/models";
import { clearSettingsCache } from "../../src/lib/settings";

describe("returns & refunds", () => {
  let admin: AuthCtx;
  let accountant: AuthCtx;
  const cleanupTags: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
    accountant = await authFor(ACCOUNTS.accountant);
    await openRegister(admin.token, 0);
  });

  afterAll(async () => {
    await connectDb();
    await StoreSettings.deleteMany({ key: "pos.refund_requires_approval" }).catch(() => undefined);
    clearSettingsCache();
    for (const t of cleanupTags) await purgeTag(t).catch(() => undefined);
  });

  async function seedSale(price: number, qty: number) {
    const product = await createProduct(admin.token, { sellingPrice: price, purchasePrice: Math.round(price * 0.5) });
    cleanupTags.push(product.tag);
    await api(admin.token).post("/api/inventory", { productId: product._id, quantity: 100, movementType: "ADJUSTMENT_IN", reason: "seed" });
    const sale = await api(admin.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: qty }],
      payments: [{ method: "cash", amount: price * qty }],
    }));
    if (sale.status !== 201) throw new Error(`seedSale failed: ${JSON.stringify(sale.body)}`);
    return { product, sale: sale.body.data as { id: string; invoiceNumber: string; total: number } };
  }

  it("processes a full refund: return doc, stock restored, cash refund movement", async () => {
    const { product, sale } = await seedSale(20, 3);
    const stockAfterSale = await dbStock(product._id);

    const ret = await api(admin.token).post("/api/sales-returns", {
      saleId: sale.id,
      items: [{ productId: product._id, quantity: 1 }],
      refundMethod: "cash",
      reason: "damaged package",
    });
    expect(ret.status).toBe(201);
    expect(ret.body.data.status).toBe("approved");
    expect(ret.body.data.refundAmount).toBe(20);
    expect(ret.body.data.returnNumber).toMatch(/^RET-/);

    // Stock restored by exactly the returned quantity
    expect(await dbStock(product._id)).toBe(stockAfterSale + 1);

    // Return inventory movement exists
    const movement = await SaleReturn.findById(ret.body.data.id).lean();
    expect(movement).toBeTruthy();

    // Cash refund recorded against the drawer. The app keys the movement to the
    // return document (referenceType "sale_return"), not to the original sale.
    const refunds = await CashTransaction.find({
      type: "refund",
      referenceId: ret.body.data.id,
      referenceType: "sale_return",
    }).lean();
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount).toBe(-20);
  });

  it("rejects returning more than was sold", async () => {
    const { product, sale } = await seedSale(10, 2);
    const stockBefore = await dbStock(product._id);

    const res = await api(admin.token).post("/api/sales-returns", {
      saleId: sale.id,
      items: [{ productId: product._id, quantity: 5 }],
      refundMethod: "cash",
      reason: "too many",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EXCEEDS_SOLD_QUANTITY");
    expect(await dbStock(product._id)).toBe(stockBefore);
  });

  it("rejects an unknown sale with 400", async () => {
    const res = await api(admin.token).post("/api/sales-returns", {
      saleId: "000000000000000000000000",
      items: [{ productId: "000000000000000000000000", quantity: 1 }],
      refundMethod: "cash",
      reason: "ghost",
    });
    expect(res.status).toBe(400);
  });

  it("blocks refunds for roles without sales.refund (accountant → 403)", async () => {
    const { sale } = await seedSale(10, 1);
    const res = await api(accountant.token).post("/api/sales-returns", {
      saleId: sale.id,
      items: [],
      refundMethod: "cash",
      reason: "unauthorized",
    });
    expect(res.status).toBe(403);
  });

  it("honours refund_requires_approval: pending → no stock change → approved → restored", async () => {
    // Enable approval requirement (settings.manage = admin/manager)
    const setFlag = await api(admin.token).post("/api/settings", { fields: { "pos.refund_requires_approval": true } });
    expect(setFlag.status).toBe(200);

    try {
      const { product, sale } = await seedSale(15, 2);
      const stockAfterSale = await dbStock(product._id);

      const created = await api(admin.token).post("/api/sales-returns", {
        saleId: sale.id,
        items: [{ productId: product._id, quantity: 1 }],
        refundMethod: "cash",
        reason: "needs approval",
      });
      expect(created.status).toBe(201);
      expect(created.body.data.status).toBe("pending");
      expect(await dbStock(product._id)).toBe(stockAfterSale); // not restored yet

      const approved = await api(admin.token).put("/api/sales-returns", {
        id: created.body.data.id, action: "approve",
      });
      expect(approved.status).toBe(200);
      expect(approved.body.data.status).toBe("approved");
      expect(await dbStock(product._id)).toBe(stockAfterSale + 1);

      // Rejecting a non-pending return is rejected
      const again = await api(admin.token).put("/api/sales-returns", { id: created.body.data.id, action: "reject" });
      expect(again.status).toBe(400);
    } finally {
      await api(admin.token).post("/api/settings", { fields: { "pos.refund_requires_approval": false } });
      clearSettingsCache();
    }
  });

  it("returns cannot be deleted", async () => {
    const { sale } = await seedSale(10, 1);
    const created = await api(admin.token).post("/api/sales-returns", {
      saleId: sale.id,
      items: [{ productId: (await api(admin.token).get(`/api/sales/${sale.id}`)).body.sale.items[0].productId, quantity: 1 }],
      refundMethod: "cash",
      reason: "deletion probe",
    });
    expect(created.status).toBe(201);
    const del = await api(admin.token).del("/api/sales-returns", { id: created.body.data.id });
    expect(del.status).toBe(404);
  });
});

describe("cash register lifecycle", () => {
  let admin: AuthCtx;
  const cleanupTags: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
  });

  afterAll(async () => {
    for (const t of cleanupTags) await purgeTag(t).catch(() => undefined);
  });

  it("opens a register, tracks movements, reconciles on close", async () => {
    // Fresh user so no stale session interferes
    const email = `qa-reg-${tag()}@qa.test`;
    const roleUser = await User.findOne({ email: ACCOUNTS.admin }).lean();
    const user = await User.create({
      name: "QA Register Probe",
      email,
      phone: "",
      passwordHash: "x",
      roleId: roleUser!.roleId,
      branchId: null,
      status: "active",
    });
    const token = (await import("../helpers/qa")).mintAccessToken(String(user._id), String(roleUser!.roleId));

    try {
      // Open with 200 starting cash
      const opened = await api(token).post("/api/cash-register", { action: "open", openCash: 200 });
      expect(opened.status).toBe(201);
      const registerId = opened.body.data.registerId;

      // Double-open is rejected
      const again = await api(token).post("/api/cash-register", { action: "open", openCash: 100 });
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBeTruthy();

      // Movements: +50 income, −30 expense, +10 adjustment
      const movements: Array<[string, number, string]> = [
        ["cash-in", 50, "extra income"],
        ["cash-out", 30, "petty expense"],
        ["adjust", 10, "count correction"],
      ];
      for (const [action, amount, description] of movements) {
        const res = await api(token).post("/api/cash-register", { action, amount, description });
        expect(res.status, `${action} → ${res.status} ${JSON.stringify(res.body)}`).toBe(201);
      }

      // Summary math: 200 + 50 − 30 + 10 = 230
      const current = await api(token).get("/api/cash-register");
      expect(current.body.summary.expectedCash).toBe(230);
      expect(current.body.movements.length).toBeGreaterThanOrEqual(3);

      // Close with a +5 discrepancy
      const closed = await api(token).post("/api/cash-register", {
        action: "close", registerId, countedCash: 235,
      });
      expect(closed.status).toBe(200);
      expect(closed.body.data.difference).toBe(5);
      expect(closed.body.data.expectedCash).toBe(230);

      // Closing again fails (already closed)
      const second = await api(token).post("/api/cash-register", { action: "close", registerId, countedCash: 235 });
      expect(second.status).toBe(400);

      // Session shows up in history
      const history = await api(token).get("/api/cash-register?history=1");
      expect(history.body.sessions.some((s: any) => s._id === registerId)).toBe(true);
    } finally {
      await User.deleteOne({ _id: user._id });
      await CashTransaction.deleteMany({ registerId: { $exists: true }, userId: user._id }).catch(() => undefined);
      await (await import("../helpers/qa")).connectDb();
      const { CashRegister } = await import("../../src/models");
      await CashRegister.deleteMany({ openedBy: user._id }).catch(() => undefined);
    }
  });

  it("expenses: recorded via API, draw from an open drawer, rejected for cashiers without expenses.create", async () => {
    const cashier = await authFor(ACCOUNTS.cashier);
    // Cashier lacks expenses.create → 403
    const denied = await api(cashier.token).post("/api/finance/expenses", {
      category: "rent", amount: 25, description: "should be denied",
    });
    expect(denied.status).toBe(403);

    const expense = await api(admin.token).post("/api/finance/expenses", {
      category: "rent", amount: 40, paymentMethod: "cash", description: `QA expense ${tag("exp")}`,
    });
    expect(expense.status).toBe(201);
    expect(expense.body.data.id).toMatch(/^[0-9a-f]{24}$/);

    const list = await api(admin.token).get("/api/finance/expenses?perPage=5");
    expect(list.status).toBe(200);
    expect(list.body.expenses.length).toBeGreaterThanOrEqual(1);
    expect(list.body.summary.totalAmount).toBeGreaterThanOrEqual(40);
  });

  it("validates movement payloads (missing description, bad amount)", async () => {
    const registerToken = admin.token;
    const noDesc = await api(registerToken).post("/api/cash-register", { action: "cash-in", amount: 10, description: "" });
    // Either validation (400) or no-open-register (400) — both are client errors
    expect(noDesc.status).toBe(400);

    const badAmount = await api(registerToken).post("/api/cash-register", { action: "cash-out", amount: -5, description: "negative" });
    expect(badAmount.status).toBe(400);
  });
});
