/**
 * POS enhancements — wholesale pricing, customer reward credit and in-POS
 * refunds/exchanges. Exercises the real HTTP API against the QA database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  api,
  authFor,
  checkoutPayload,
  connectDb,
  createCustomer,
  createProduct,
  dbStock,
  openRegister,
  purgeTag,
  tag,
  type AuthCtx,
} from "../helpers/qa";
import {
  CashTransaction,
  Customer,
  CustomerBonusTransaction,
  InventoryMovement,
  Sale,
  SaleReturn,
} from "../../src/models";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

describe("POS wholesale, reward credit and exchanges", () => {
  let admin: AuthCtx;
  let cashier: AuthCtx;
  let accountant: AuthCtx;
  const cleanupTags: string[] = [];

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
    cashier = await authFor(ACCOUNTS.cashier);
    accountant = await authFor(ACCOUNTS.accountant);
    await openRegister(admin.token, 0);
  });

  afterAll(async () => {
    for (const t of cleanupTags) await purgeTag(t).catch(() => undefined);
  });

  async function seedProduct(sellingPrice: number, wholesalePrice: number, extra: Record<string, unknown> = {}) {
    const product = await createProduct(admin.token, {
      sellingPrice,
      wholesalePrice,
      purchasePrice: Math.round(sellingPrice * 0.5),
      ...extra,
    });
    cleanupTags.push(product.tag);
    await api(admin.token).post("/api/inventory", {
      productId: product._id,
      quantity: 200,
      movementType: "ADJUSTMENT_IN",
      reason: "seed",
    });
    return product;
  }

  async function seedCustomer(overrides: Record<string, unknown> = {}) {
    const customer = await createCustomer(admin.token, overrides);
    cleanupTags.push(customer.tag);
    return customer;
  }

  async function updateCustomer(id: string, name: string, overrides: Record<string, unknown>) {
    const current = await Customer.findById(id).lean();
    const res = await api(admin.token).post("/api/customers", {
      id,
      name,
      phone: current?.phone ?? "",
      email: current?.email ?? "",
      address: current?.address ?? "",
      notes: current?.notes ?? "",
      status: current?.status ?? "active",
      ...overrides,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data.customer;
  }

  describe("wholesale pricing", () => {
    it("uses retail price by default and wholesale price only when explicitly requested", async () => {
      const product = await seedProduct(100, 80);

      const retail = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 2 }],
          payments: [{ method: "card", amount: 200 }],
        })
      );
      expect(retail.status).toBe(201);
      expect(retail.body.data.total).toBe(200);
      expect(retail.body.data.pricingMode).toBe("retail");

      const wholesale = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 2 }],
          payments: [{ method: "card", amount: 160 }],
          pricingMode: "wholesale",
        })
      );
      expect(wholesale.status).toBe(201);
      expect(wholesale.body.data.total).toBe(160);
      expect(wholesale.body.data.pricingMode).toBe("wholesale");

      const detail = await api(admin.token).get(`/api/sales/${wholesale.body.data.id}`);
      expect(detail.body.sale.items[0].sellingPrice).toBe(80);
      expect(detail.body.sale.items[0].pricingMode).toBe("wholesale");
    });

    it("blocks a cashier without sales.wholesale and refuses products with no wholesale price", async () => {
      const product = await seedProduct(50, 40);

      const denied = await api(cashier.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 1 }],
          payments: [{ method: "card", amount: 40 }],
          pricingMode: "wholesale",
        })
      );
      expect(denied.status).toBe(403);
      expect(denied.body.error.message).toMatch(/permission to apply wholesale/i);

      const noWholesale = await seedProduct(30, 0);
      const missing = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: noWholesale._id, quantity: 1 }],
          payments: [{ method: "card", amount: 30 }],
          pricingMode: "wholesale",
        })
      );
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe("WHOLESALE_PRICE_UNAVAILABLE");
    });

    it("requires the selected customer to be wholesale-eligible", async () => {
      const product = await seedProduct(100, 70);
      const customer = await seedCustomer();

      const denied = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 1 }],
          customerId: customer._id,
          payments: [{ method: "card", amount: 70 }],
          pricingMode: "wholesale",
        })
      );
      expect(denied.status).toBe(400);
      expect(denied.body.error.code).toBe("CUSTOMER_NOT_WHOLESALE_ELIGIBLE");

      await updateCustomer(customer._id, customer.name, { wholesaleEligible: true });
      const allowed = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 1 }],
          customerId: customer._id,
          payments: [{ method: "card", amount: 70 }],
          pricingMode: "wholesale",
        })
      );
      expect(allowed.status).toBe(201);
      expect(allowed.body.data.total).toBe(70);
    });

    it("restores cashier discount authority and enforces the configured cap", async () => {
      const product = await seedProduct(100, 80);

      const allowed = await api(cashier.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 1 }],
          discount: 10,
          discountType: "percent",
          payments: [{ method: "card", amount: 90 }],
        })
      );
      expect(allowed.status).toBe(201);
      expect(allowed.body.data.total).toBe(90);

      const over = await api(cashier.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 1 }],
          discount: 15,
          discountType: "percent",
          payments: [{ method: "card", amount: 85 }],
        })
      );
      expect(over.status).toBe(400);
      expect(over.body.error.message).toMatch(/exceeds the maximum allowed/i);

      const lineOver = await api(cashier.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 1, unitDiscount: 15 }],
          discountType: "percent",
          payments: [{ method: "card", amount: 85 }],
        })
      );
      expect(lineOver.status).toBe(400);
    });
  });

  describe("customer reward credit", () => {
    it("earns 1% on net merchandise, shows the balance and is idempotent on replay", async () => {
      const product = await seedProduct(1000, 800);
      const customer = await seedCustomer({ bonusPercent: 1 });
      const clientTransactionId = `bonus-${tag("idem")}`;

      const sale = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 2 }],
          customerId: customer._id,
          payments: [{ method: "card", amount: 2000 }],
          clientTransactionId,
          note: customer.tag,
        })
      );
      expect(sale.status).toBe(201);
      expect(sale.body.data.bonusEarned).toBe(20);

      const after = await Customer.findById(customer._id).lean();
      expect(after?.bonusBalance).toBe(20);
      const ledger = await CustomerBonusTransaction.find({ customerId: customer._id }).lean();
      expect(ledger).toHaveLength(1);
      expect(ledger[0].type).toBe("EARN");
      expect(ledger[0].amount).toBe(20);

      // Replaying the same checkout returns the same sale and never re-credits.
      const replay = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 2 }],
          customerId: customer._id,
          payments: [{ method: "card", amount: 2000 }],
          clientTransactionId,
          note: customer.tag,
        })
      );
      expect(replay.status).toBe(200);
      expect(await CustomerBonusTransaction.countDocuments({ customerId: customer._id })).toBe(1);
      expect((await Customer.findById(customer._id).lean())?.bonusBalance).toBe(20);

      const detail = await api(admin.token).get(`/api/customers/${customer._id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.bonusBalance).toBe(20);
      expect(detail.body.bonusLedger.entries[0].type).toBe("EARN");
    });

    it("redeems available credit, rejects over-redemption, and remains separate from debt", async () => {
      const product = await seedProduct(100, 80);
      const customer = await seedCustomer({ bonusPercent: 1 });
      await Customer.updateOne({ _id: customer._id }, { $set: { bonusBalance: 20 } });
      await CustomerBonusTransaction.create({
        customerId: customer._id,
        branchId: null,
        type: "ADJUSTMENT",
        amount: 20,
        balanceAfter: 20,
        referenceType: "adjustment",
        referenceId: null,
        description: "test seed",
        idempotencyKey: `seed:${customer._id}`,
        userId: admin.userId,
      });

      const sale = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 1 }],
          customerId: customer._id,
          payments: [
            { method: "bonus", amount: 10 },
            { method: "card", amount: 90 },
          ],
          note: customer.tag,
        })
      );
      expect(sale.status).toBe(201);
      expect(sale.body.data.bonusRedeemed).toBe(10);
      // 100 − 10 bonus = 90 base; 1% earns 0.90 on top.
      expect(sale.body.data.bonusEarned).toBe(0.9);

      const after = await Customer.findById(customer._id).lean();
      expect(round2(after?.bonusBalance ?? 0)).toBe(10.9);

      // Credit/debt ledger is untouched by reward credit.
      const customerDetail = await api(admin.token).get(`/api/customers/${customer._id}`);
      expect(customerDetail.body.balance).toBe(0);

      const over = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 1 }],
          customerId: customer._id,
          payments: [
            { method: "bonus", amount: 50 },
            { method: "card", amount: 50 },
          ],
          note: customer.tag,
        })
      );
      expect(over.status).toBe(400);
      expect(over.body.error.code).toBe("BONUS_INSUFFICIENT_BALANCE");
    });

    it("reverses earned credit proportionally across partial returns without over-reversing", async () => {
      const product = await seedProduct(1000, 800);
      const customer = await seedCustomer({ bonusPercent: 1 });

      const sale = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 2 }],
          customerId: customer._id,
          payments: [{ method: "card", amount: 2000 }],
          note: customer.tag,
        })
      );
      expect(sale.status).toBe(201);
      expect((await Customer.findById(customer._id).lean())?.bonusBalance).toBe(20);

      const lookup = await api(admin.token).get(`/api/pos/sales-lookup?invoice=${encodeURIComponent(sale.body.data.invoiceNumber)}`);
      expect(lookup.status).toBe(200);
      const line = lookup.body.sale.items[0];

      const first = await api(admin.token).post("/api/sales-returns", {
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "credit",
        reason: `partial ${customer.tag}`,
        note: customer.tag,
      });
      expect(first.status).toBe(201);
      expect(first.body.data.bonusReversed).toBe(10);

      const second = await api(admin.token).post("/api/sales-returns", {
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "credit",
        reason: `remaining ${customer.tag}`,
        note: customer.tag,
      });
      expect(second.status).toBe(201);
      expect(second.body.data.bonusReversed).toBe(10);

      // A third return is impossible; no extra reversal can ever be issued.
      const third = await api(admin.token).post("/api/sales-returns", {
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "credit",
        reason: "over-return",
        note: customer.tag,
      });
      expect(third.status).toBe(400);
      expect(third.body.error.code).toBe("EXCEEDS_SOLD_QUANTITY");

      const returns = await SaleReturn.find({ saleId: sale.body.data.id, status: "approved" }).lean();
      expect(returns.reduce((s, r) => s + (r.bonusReversed ?? 0), 0)).toBe(20);
    });

    it("reports earned, redeemed and reversed reward credit separately", async () => {
      const res = await api(admin.token).get("/api/reports/customers?view=bonus&perPage=100");
      expect(res.status).toBe(200);
      expect(res.body.summary.earned).toBeGreaterThan(0);
      expect(res.body.rows.some((r: { earned: number }) => r.earned > 0)).toBe(true);
    });
  });

  describe("POS refunds and exchanges", () => {
    it("supports partial and full returns priced from the original sale", async () => {
      const product = await seedProduct(100, 80);
      const sale = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 2 }],
          payments: [{ method: "card", amount: 200 }],
          note: product.tag,
        })
      );
      expect(sale.status).toBe(201);
      const stockAfterSale = await dbStock(product._id);

      const lookup = await api(admin.token).get(`/api/pos/sales-lookup?invoice=${encodeURIComponent(sale.body.data.invoiceNumber)}`);
      const line = lookup.body.sale.items[0];
      expect(line.returnableQuantity).toBe(2);

      const partial = await api(admin.token).post("/api/sales-returns", {
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "cash",
        reason: `partial ${product.tag}`,
        note: product.tag,
      });
      expect(partial.status).toBe(201);
      expect(partial.body.data.refundAmount).toBe(100);
      expect(await dbStock(product._id)).toBe(stockAfterSale + 1);

      const full = await api(admin.token).post("/api/sales-returns", {
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "cash",
        reason: `full ${product.tag}`,
        note: product.tag,
      });
      expect(full.status).toBe(201);
      expect(full.body.data.refundAmount).toBe(100);
      expect(await dbStock(product._id)).toBe(stockAfterSale + 2);

      const third = await api(admin.token).post("/api/sales-returns", {
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "cash",
        reason: "extra",
        note: product.tag,
      });
      expect(third.status).toBe(400);
    });

    it("collects the difference when the replacement costs more", async () => {
      const a = await seedProduct(100, 80);
      const b = await seedProduct(50, 40);
      const sale = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: a._id, quantity: 1 }],
          payments: [{ method: "card", amount: 100 }],
          note: a.tag,
        })
      );
      const lookup = await api(admin.token).get(`/api/pos/sales-lookup?saleId=${sale.body.data.id}`);
      const line = lookup.body.sale.items[0];
      const stockA = await dbStock(a._id);
      const stockB = await dbStock(b._id);

      const res = await api(admin.token).post("/api/pos/exchanges", {
        clientTransactionId: `exch-more-${tag("idem")}`,
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "cash",
        reason: `exchange ${a.tag}`,
        note: a.tag,
        replacement: {
          items: [{ productId: b._id, quantity: 3 }],
          discount: 0,
          discountType: "amount",
          pricingMode: "retail",
        },
        payments: [{ method: "cash", amount: 50 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.refundAmount).toBe(100);
      expect(res.body.data.replacementTotal).toBe(150);
      expect(res.body.data.netAmount).toBe(50);
      expect(res.body.data.replacementSaleId).toBeTruthy();

      expect(await dbStock(a._id)).toBe(stockA + 1);
      expect(await dbStock(b._id)).toBe(stockB - 3);

      const replacement = await Sale.findById(res.body.data.replacementSaleId).lean();
      expect(replacement?.originalSaleId?.toString()).toBe(sale.body.data.id);
      expect(replacement?.total).toBe(150);

      const cash = await CashTransaction.findOne({
        registerId: { $exists: true },
        referenceType: "sale",
        referenceId: replacement?._id,
        type: "sale",
      }).lean();
      expect(cash?.amount).toBe(50);
    });

    it("refunds the excess when the return is worth more than the replacement", async () => {
      const a = await seedProduct(100, 80);
      const b = await seedProduct(50, 40);
      const sale = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: a._id, quantity: 2 }],
          payments: [{ method: "card", amount: 200 }],
          note: a.tag,
        })
      );
      const lookup = await api(admin.token).get(`/api/pos/sales-lookup?saleId=${sale.body.data.id}`);
      const line = lookup.body.sale.items[0];

      const res = await api(admin.token).post("/api/pos/exchanges", {
        clientTransactionId: `exch-less-${tag("idem")}`,
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "cash",
        reason: `exchange ${a.tag}`,
        note: a.tag,
        replacement: {
          items: [{ productId: b._id, quantity: 1 }],
          discount: 0,
          discountType: "amount",
          pricingMode: "retail",
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.netAmount).toBe(-50);
      expect(res.body.data.refundDue).toBe(50);
      expect(res.body.data.replacementTotal).toBe(50);

      const refund = await CashTransaction.findOne({
        type: "refund",
        referenceId: res.body.data.id,
        referenceType: "sale_return",
      }).lean();
      expect(refund?.amount).toBe(-50);
    });

    it("settles an even exchange without any payment", async () => {
      const product = await seedProduct(50, 40);
      const sale = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 2 }],
          payments: [{ method: "card", amount: 100 }],
          note: product.tag,
        })
      );
      const lookup = await api(admin.token).get(`/api/pos/sales-lookup?saleId=${sale.body.data.id}`);
      const line = lookup.body.sale.items[0];
      const stock = await dbStock(product._id);

      const res = await api(admin.token).post("/api/pos/exchanges", {
        clientTransactionId: `exch-even-${tag("idem")}`,
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "cash",
        reason: `even ${product.tag}`,
        note: product.tag,
        replacement: {
          items: [{ productId: product._id, quantity: 1 }],
          discount: 0,
          discountType: "amount",
          pricingMode: "retail",
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.netAmount).toBe(0);
      expect(res.body.data.refundDue).toBe(0);
      expect(await dbStock(product._id)).toBe(stock); // returned 1, sold 1
    });

    it("prevents duplicate exchange submissions from refunding or restocking twice", async () => {
      const product = await seedProduct(100, 80);
      const sale = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 1 }],
          payments: [{ method: "card", amount: 100 }],
          note: product.tag,
        })
      );
      const lookup = await api(admin.token).get(`/api/pos/sales-lookup?saleId=${sale.body.data.id}`);
      const line = lookup.body.sale.items[0];
      const stock = await dbStock(product._id);
      const clientTransactionId = `exch-dup-${tag("idem")}`;
      const payload = {
        clientTransactionId,
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "cash",
        reason: `duplicate ${product.tag}`,
        note: product.tag,
        replacement: null,
      };

      const first = await api(admin.token).post("/api/pos/exchanges", payload);
      expect(first.status).toBe(201);
      expect(await dbStock(product._id)).toBe(stock + 1);

      const replay = await api(admin.token).post("/api/pos/exchanges", payload);
      expect([200, 201]).toContain(replay.status);
      expect(replay.body.alreadyProcessed).toBe(true);
      expect(await dbStock(product._id)).toBe(stock + 1);
      expect(await SaleReturn.countDocuments({ clientTransactionId })).toBe(1);
    });

    it("handles direct-sale returns/exchanges without touching inventory", async () => {
      const directTag = tag("direct-sale");
      cleanupTags.push(directTag);
      const directSale = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [],
          directItems: [
            { description: `Market grapes ${directTag}`, quantity: 1, unitPrice: 30, unitCost: 10, taxRate: 0 },
          ],
          payments: [{ method: "card", amount: 30 }],
          note: directTag,
        })
      );
      expect(directSale.status).toBe(201);
      expect(directSale.body.data.total).toBe(30);

      const saleId = directSale.body.data.id;

      const lookup = await api(admin.token).get(`/api/pos/sales-lookup?saleId=${saleId}`);
      const line = lookup.body.sale.items[0];
      expect(line.itemType).toBe("direct");
      expect(line.productId).toBeNull();

      const before = await InventoryMovement.countDocuments({ referenceId: saleId });
      const res = await api(admin.token).post("/api/pos/exchanges", {
        clientTransactionId: `exch-direct-${tag("idem")}`,
        saleId,
        items: [{ lineId: line.lineId, quantity: 1, restock: true }],
        refundMethod: "cash",
        reason: "direct exchange",
        note: directTag,
        replacement: {
          items: [],
          directItems: [
            { description: "Market apples", quantity: 1, unitPrice: 40, unitCost: 12, taxRate: 0 },
          ],
          discount: 0,
          discountType: "amount",
          pricingMode: "retail",
        },
        payments: [{ method: "cash", amount: 10 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.netAmount).toBe(10);

      const returnDoc = await SaleReturn.findById(res.body.data.id).lean();
      expect(returnDoc?.items[0].itemType).toBe("direct");
      expect(returnDoc?.items[0].restock).toBe(false);
      expect(await InventoryMovement.countDocuments({ referenceId: res.body.data.id })).toBe(0);
      expect(await InventoryMovement.countDocuments({ referenceId: saleId })).toBe(before);
    });

    it("requires refund permission and rejects wholesale replacement without authorization", async () => {
      const product = await seedProduct(100, 80);
      const sale = await api(admin.token).post(
        "/api/sales",
        checkoutPayload({
          items: [{ productId: product._id, quantity: 1 }],
          payments: [{ method: "card", amount: 100 }],
          note: product.tag,
        })
      );
      const lookup = await api(admin.token).get(`/api/pos/sales-lookup?saleId=${sale.body.data.id}`);
      const line = lookup.body.sale.items[0];

      const denied = await api(accountant.token).post("/api/pos/exchanges", {
        clientTransactionId: `denied-${tag("idem")}`,
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "cash",
        reason: "unauthorized",
        note: product.tag,
      });
      expect(denied.status).toBe(403);

      const wholesaleDenied = await api(cashier.token).post("/api/pos/exchanges", {
        clientTransactionId: `cashier-wholesale-${tag("idem")}`,
        saleId: sale.body.data.id,
        items: [{ lineId: line.lineId, quantity: 1 }],
        refundMethod: "cash",
        reason: "unauthorized wholesale",
        note: product.tag,
        replacement: {
          items: [{ productId: product._id, quantity: 1 }],
          discount: 0,
          discountType: "amount",
          pricingMode: "wholesale",
        },
        payments: [],
      });
      expect(wholesaleDenied.status).toBe(403);
      expect(wholesaleDenied.body.error.message).toMatch(/wholesale/i);
    });
  });
});
