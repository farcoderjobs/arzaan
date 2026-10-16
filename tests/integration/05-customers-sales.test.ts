/**
 * Areas 6, 7, 8 — Customer records, credit sales and partial payments; POS
 * calculations (discounts, taxes, payment methods, change); sales persistence,
 * receipt data, and duplicate-checkout prevention.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  api,
  authFor,
  connectDb,
  checkoutPayload,
  createCustomer,
  createProduct,
  dbStock,
  openRegister,
  purgeTag,
  tag,
  type AuthCtx,
} from "../helpers/qa";
import { CustomerTransaction } from "../../src/models";

describe("customers, credit & payments", () => {
  let admin: AuthCtx;
  const cleanupTags: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
  });

  afterAll(async () => {
    for (const t of cleanupTags) await purgeTag(t).catch(() => undefined);
  });

  async function seedSaleableProduct(price: number) {
    const product = await createProduct(admin.token, { sellingPrice: price, purchasePrice: Math.round(price * 0.6) });
    cleanupTags.push(product.tag);
    await api(admin.token).post("/api/inventory", { productId: product._id, quantity: 50, movementType: "ADJUSTMENT_IN", reason: "seed" });
    return product;
  }

  it("creates a customer and reads it back with balance 0", async () => {
    const customer = await createCustomer(admin.token);
    cleanupTags.push(customer.tag);

    const list = await api(admin.token).get(`/api/customers?search=${encodeURIComponent(customer.name)}&withBalance=1`);
    expect(list.status).toBe(200);
    const row = list.body.customers.find((c: any) => c._id === customer._id);
    expect(row).toBeTruthy();
    expect(row.balance).toBe(0);
  });

  it("rejects an invalid customer email with 400", async () => {
    const t = tag("cust");
    const res = await api(admin.token).post("/api/customers", { name: `QA ${t}`, email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toHaveProperty("email");
  });

  it("records a credit sale, builds the customer balance, accepts partial payments, blocks overpayment", async () => {
    const product = await seedSaleableProduct(40);
    const customer = await createCustomer(admin.token);
    cleanupTags.push(customer.tag);

    const sale = await api(admin.token).post(
      "/api/sales",
      checkoutPayload({
        items: [{ productId: product._id, quantity: 3 }],
        customerId: customer._id,
        payments: [{ method: "credit", amount: 120 }],
      })
    );
    expect(sale.status).toBe(201);
    expect(sale.body.data.total).toBe(120);
    expect(sale.body.data.creditUsed).toBe(120);

    const balanceAfterSale = await api(admin.token).get(`/api/customers?search=${encodeURIComponent(customer.name)}&withBalance=1`);
    const balance1 = balanceAfterSale.body.customers.find((c: any) => c._id === customer._id).balance;
    expect(balance1).toBe(120);

    // Partial payment of 50 → balance 70
    const partial = await api(admin.token).post("/api/customers", {
      action: "payment", customerId: customer._id, amount: 50, method: "cash",
    });
    expect(partial.status).toBe(201);
    expect(partial.body.data.balanceAfter).toBe(70);

    // Overpayment blocked
    const over = await api(admin.token).post("/api/customers", {
      action: "payment", customerId: customer._id, amount: 100, method: "cash",
    });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/exceeds the outstanding balance/i);

    // Zero/negative amounts blocked
    const zero = await api(admin.token).post("/api/customers", {
      action: "payment", customerId: customer._id, amount: 0, method: "cash",
    });
    expect(zero.status).toBe(400);

    // Ledger rows exist: SALE +120, PAYMENT -50
    const txs = await CustomerTransaction.find({ customerId: customer._id }).lean();
    const saleTx = txs.find((t) => t.type === "SALE");
    const payTx = txs.find((t) => t.type === "PAYMENT");
    expect(saleTx?.amount).toBe(120);
    expect(payTx?.amount).toBe(-50);
  });

  it("requires a customer for credit payments (requireCustomerForCredit)", async () => {
    const product = await seedSaleableProduct(10);
    const res = await api(admin.token).post("/api/sales", {
      items: [{ productId: product._id, quantity: 1 }],
      payments: [{ method: "credit", amount: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/require a selected customer/i);
  });

  it("deactivates customers with financial history instead of deleting them", async () => {
    const product = await seedSaleableProduct(25);
    const customer = await createCustomer(admin.token);
    cleanupTags.push(customer.tag);

    await api(admin.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 1 }],
      customerId: customer._id,
      payments: [{ method: "card", amount: 25 }],
    }));

    const del = await api(admin.token).del("/api/customers", { id: customer._id });
    expect(del.status).toBe(200);
    expect(del.body.message).toMatch(/deactivated instead of deleted/i);

    const reread = await api(admin.token).get(`/api/customers?search=${encodeURIComponent(customer.name)}&status=inactive`);
    expect(reread.body.customers.some((c: any) => c._id === customer._id)).toBe(true);
  });
});

describe("POS calculations & checkout", () => {
  let admin: AuthCtx;
  let cashier: AuthCtx;
  const cleanupTags: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
    cashier = await authFor(ACCOUNTS.cashier);
    await openRegister(cashier.token, 100);
    // Discounts require sales.discount (Cashier lacks it), so discount flows run
    // as admin — which needs its own open drawer for cash payments.
    await openRegister(admin.token, 100);
  });

  afterAll(async () => {
    for (const t of cleanupTags) await purgeTag(t).catch(() => undefined);
  });

  async function seedProduct(price: number) {
    const product = await createProduct(admin.token, { sellingPrice: price, purchasePrice: Math.round(price * 0.5) });
    cleanupTags.push(product.tag);
    await api(admin.token).post("/api/inventory", { productId: product._id, quantity: 100, movementType: "ADJUSTMENT_IN", reason: "seed" });
    return product;
  }

  // Discounts require the sales.discount permission (SuperAdmin/Manager hold
  // it; Cashier does not), so discount-authorised flows run as admin. The
  // beforeAll opens an admin drawer for the cash-change assertions.
  it("computes totals server-side: line items, amount discount, zero tax by default", async () => {
    const product = await seedProduct(20);
    const sale = await api(admin.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 3 }],
      discount: 5,
      discountType: "amount",
      payments: [{ method: "cash", amount: 100 }],
    }));
    expect(sale.status).toBe(201);
    // paidAmount is what actually settles the sale: computeSalePaymentFields
    // caps it at `total` and excludes the change handed back (100 tendered − 45
    // change = 55 applied). changeAmount keeps the tendered difference.
    expect(sale.body.data).toMatchObject({ total: 55, paidAmount: 55, changeAmount: 45, status: "completed" });
  });

  it("computes percent discounts", async () => {
    const product = await seedProduct(20);
    const sale = await api(admin.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 3 }],
      discount: 10,
      discountType: "percent",
      payments: [{ method: "card", amount: 54 }],
    }));
    expect(sale.status).toBe(201);
    expect(sale.body.data.total).toBe(54); // 60 − 10% = 54
  });

  it("enforces the discount cap from settings (maxCashierDiscountPercent = 10)", async () => {
    const product = await seedProduct(20);
    const res = await api(admin.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 1 }],
      discount: 15,
      discountType: "percent",
      payments: [{ method: "card", amount: 20 }],
    }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/exceeds the maximum allowed/i);
  });

  it("blocks cashiers without the sales.discount permission from discounting", async () => {
    const product = await seedProduct(20);

    // Sale-level discount
    const saleLevel = await api(cashier.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 1 }],
      discount: 5,
      discountType: "amount",
      payments: [{ method: "card", amount: 20 }],
    }));
    expect(saleLevel.status).toBe(403);
    expect(saleLevel.body.error.message).toMatch(/permission to apply discounts/i);

    // Per-line discount
    const lineLevel = await api(cashier.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 1, unitDiscount: 5 }],
      payments: [{ method: "card", amount: 20 }],
    }));
    expect(lineLevel.status).toBe(403);
    expect(lineLevel.body.error.message).toMatch(/permission to apply discounts/i);
  });

  it("applies per-line discounts and never trusts client totals", async () => {
    const product = await seedProduct(20);
    const sale = await api(admin.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 2, unitDiscount: 5 }],
      payments: [{ method: "cash", amount: 40 }],
    }));
    expect(sale.status).toBe(201);
    // Per the pricing rule (lib/commerce.ts): with discountType "amount" the
    // line discount applies ONCE per line — 2×20 − 5 = 35 — regardless of what
    // a client would claim as its total.
    expect(sale.body.data.total).toBe(35);
  });

  it("supports mixed payment methods with correct change", async () => {
    const product = await seedProduct(50);
    const sale = await api(cashier.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 2 }],
      payments: [
        { method: "cash", amount: 60 },
        { method: "card", amount: 40 },
      ],
    }));
    expect(sale.status).toBe(201);
    expect(sale.body.data.total).toBe(100);
    expect(sale.body.data.paidAmount).toBe(100);
    expect(sale.body.data.changeAmount).toBe(0);
  });

  it("rejects underpayment", async () => {
    const product = await seedProduct(50);
    const res = await api(cashier.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 1 }],
      payments: [{ method: "cash", amount: 10 }],
    }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYMENT");
  });

  it("rejects an empty cart and a discount above the total", async () => {
    const empty = await api(cashier.token).post("/api/sales", checkoutPayload({ items: [] }));
    expect(empty.status).toBe(400);

    const product = await seedProduct(10);
    const over = await api(admin.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 1 }],
      discount: 50,
      discountType: "amount",
      payments: [{ method: "card", amount: 10 }],
    }));
    expect(over.status).toBe(400);
  });

  it("holds a sale without deducting stock", async () => {
    const product = await seedProduct(15);
    const before = await dbStock(product._id);
    const held = await api(cashier.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 4 }],
      payments: [{ method: "cash", amount: 60 }],
      status: "held",
    }));
    expect(held.status).toBe(201);
    expect(held.body.data.status).toBe("held");
    expect(await dbStock(product._id)).toBe(before);
  });

  it("prevents duplicate checkout with the same clientTransactionId (idempotent replay)", async () => {
    const product = await seedProduct(12);
    const before = await dbStock(product._id);
    const idem = `qa-idem-${tag()}`;
    const payload = checkoutPayload({
      items: [{ productId: product._id, quantity: 2 }],
      payments: [{ method: "card", amount: 24 }],
      clientTransactionId: idem,
    });

    const first = await api(cashier.token).post("/api/sales", payload);
    expect(first.status).toBe(201);
    expect(first.body.alreadySynced).toBeUndefined();

    const replay = await api(cashier.token).post("/api/sales", payload);
    expect(replay.status).toBe(200);
    expect(replay.body.alreadySynced).toBe(true);
    expect(replay.body.data.id).toBe(first.body.data.id);

    expect(await dbStock(product._id)).toBe(before - 2); // deducted exactly once
  });

  it("persists sales in list + detail (receipt) endpoints", async () => {
    const product = await seedProduct(35);
    const sale = await api(cashier.token).post("/api/sales", checkoutPayload({
      items: [{ productId: product._id, quantity: 1 }],
      payments: [{ method: "cash", amount: 40 }],
    }));
    expect(sale.status).toBe(201);
    const invoice = sale.body.data.invoiceNumber;

    const list = await api(admin.token).get(`/api/sales?search=${encodeURIComponent(invoice)}`);
    expect(list.status).toBe(200);
    expect(list.body.sales.some((s: any) => s.invoiceNumber === invoice)).toBe(true);

    const detail = await api(admin.token).get(`/api/sales/${sale.body.data.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.sale.invoiceNumber).toBe(invoice);
    expect(detail.body.sale.items).toHaveLength(1);
    expect(detail.body.sale.items[0].quantity).toBe(1);
    expect(detail.body.sale.total).toBe(35);
    expect(detail.body.sale.payments.length + (detail.body.sale.paymentMethod ? 1 : 0)).toBeGreaterThan(0);
  });

  it("lists only completed+held sales in the API (canceled excluded by status filter)", async () => {
    const res = await api(admin.token).get("/api/sales?status=completed&perPage=5");
    expect(res.status).toBe(200);
    expect(res.body.sales.every((s: any) => s.status === "completed")).toBe(true);
  });
});
