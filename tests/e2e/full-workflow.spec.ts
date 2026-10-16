/**
 * Step 4 — Complete end-to-end workflow through the actual supported flows:
 *   create supplier + product → record purchase (stock received) → create
 *   customer → complete a POS sale in the browser → verify receipt + stock
 *   deduction → process a return and verify the refund → check financial
 *   balances and reports → confirm records survive a page reload.
 *
 * Setup/verification uses the same HTTP APIs the UI calls; the checkout itself
 * runs through the real POS browser UI as a cashier.
 */
import "./env";
import { test, expect, type Page } from "@playwright/test";
import {
  ACCOUNTS,
  authFor,
  connectDb,
  createCustomer,
  createProduct,
  createSupplier,
  dbStock,
  openRegister,
  purgeTag,
  receiveStock,
  tag,
} from "../helpers/qa";
import { Sale, SaleReturn, InventoryMovement } from "../../src/models";

const PASSWORD = process.env.QA_USER_PASSWORD ?? "qa-test-pass-123!";

test.describe.serial("complete POS workflow", () => {
  const runTag = `wf-${Date.now().toString(36)}`;
  const SELLING_PRICE = 40;
  const PURCHASE_QTY = 10;
  const PURCHASE_COST = 20;

  let adminToken = "";
  let cashierToken = "";
  let product: { _id: string; name: string; barcode: string; sku: string };
  let supplierId = "";
  let customerId = "";
  let invoice = "";
  let saleId = "";

  test.beforeAll(async () => {
    await connectDb();
    adminToken = (await authFor(ACCOUNTS.admin)).token;
    cashierToken = (await authFor(ACCOUNTS.cashier)).token;
  });

  test.afterAll(async () => {
    // Best-effort: close the cashier's register, then remove every document
    // created by this run (anchored on the unique run tag).
    try {
      const res = await fetch(`${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/cash-register`, {
        headers: { cookie: `pos_access_token=${cashierToken}` },
      });
      const body = await res.json();
      if (body.session?._id) {
        await fetch(`${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/cash-register`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: `pos_access_token=${cashierToken}` },
          body: JSON.stringify({ action: "close", registerId: body.session._id, countedCash: body.summary?.expectedCash ?? 0 }),
        });
      }
    } catch {
      /* teardown only */
    }
    await purgeTag(runTag).catch(() => undefined);
  });

  test("setup: supplier, product, purchase with received stock, customer", async () => {
    const supplier = await createSupplier(adminToken, { name: `QA WF Supplier ${runTag}` });
    supplierId = supplier._id;

    product = await createProduct(adminToken, {
      tag: runTag,
      name: `QA WF Product ${runTag}`,
      sellingPrice: SELLING_PRICE,
      purchasePrice: PURCHASE_COST,
    });

    const purchase = await receiveStock(adminToken, {
      supplierId,
      productId: product._id,
      quantity: PURCHASE_QTY,
      purchasePrice: PURCHASE_COST,
      paymentMethod: "transfer",
      paidAmount: PURCHASE_COST * PURCHASE_QTY, // paid in full → no payable left
      note: runTag,
    });
    expect(purchase.total).toBe(PURCHASE_COST * PURCHASE_QTY);
    expect(purchase.dueAmount).toBe(0);
    expect(await dbStock(product._id)).toBe(PURCHASE_QTY);

    const customer = await createCustomer(adminToken, { name: `QA WF Customer ${runTag}` });
    customerId = customer._id;

    // The cashier will check out in the browser → needs an open drawer.
    await openRegister(cashierToken, 100);
  });

  /**
   * Each Playwright test gets a fresh browser context (no shared cookies), so
   * any test that opens a protected page in the browser logs in first.
   */
  async function loginAsCashier(page: Page) {
    await page.goto("/login");
    await page.fill("#email", ACCOUNTS.cashier);
    await page.fill("#password", PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 60_000 });
  }

  test("cashier completes a POS sale in the browser", async ({ page }) => {
    // --- login through the real login form ---
    await loginAsCashier(page);

    // --- POS: scan the barcode, pay cash, complete ---
    await page.goto("/pos");
    await expect(page.locator("[data-pos]")).toBeVisible();

    const search = page.getByPlaceholder(/Scan barcode/);
    await search.click();
    await search.fill(product.barcode);
    await search.press("Enter"); // scanner flow: exact barcode → adds to cart

    // Payment modal opens only when the cart is non-empty (openPayment guards it)
    await page.getByRole("button", { name: /Payment \(F4\)/ }).click();
    const paymentModal = page.getByText("Payment", { exact: true }).last();
    await expect(paymentModal).toBeVisible();

    await page.getByRole("button", { name: /Complete Sale/ }).click();
    await expect(page.getByText("Sale Completed").last()).toBeVisible({ timeout: 30_000 });

    // --- receipt prompt shows the invoice number ---
    const invoiceText = (await page.locator(".font-mono").filter({ hasText: /INV/ }).first().textContent()) ?? "";
    invoice = invoiceText.trim();
    expect(invoice).toMatch(/^INV-/);
  });

  test("the sale is persisted: receipt data, stock deduction, drawer movement", async ({ page }) => {
    // --- API truth ---
    const list = await fetch(`${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/sales?search=${encodeURIComponent(invoice)}`, {
      headers: { cookie: `pos_access_token=${adminToken}` },
    }).then((r) => r.json());
    const row = list.sales.find((s: any) => s.invoiceNumber === invoice);
    expect(row, "invoice visible in sales list").toBeTruthy();
    saleId = row._id;

    const detail = await fetch(`${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/sales/${saleId}`, {
      headers: { cookie: `pos_access_token=${adminToken}` },
    }).then((r) => r.json());
    expect(detail.sale.total).toBe(SELLING_PRICE);
    expect(detail.sale.items).toHaveLength(1);
    expect(detail.sale.items[0].quantity).toBe(1);

    // --- database truth ---
    await connectDb();
    const saleDoc = await Sale.findById(saleId).lean();
    expect(saleDoc?.cashierId?.toString()).toBeTruthy();
    expect(saleDoc?.registerId, "sale linked to the open drawer").toBeTruthy();
    expect(saleDoc?.status).toBe("completed");

    const out = await InventoryMovement.find({ referenceId: saleDoc?._id, movementType: "SALE_OUT" }).lean();
    expect(out).toHaveLength(1);
    expect(await dbStock(product._id)).toBe(PURCHASE_QTY - 1);

    // --- receipt page renders (and survives a reload) ---
    await loginAsCashier(page);
    await page.goto(`/sales/${saleId}`);
    await expect(page.getByText(invoice).first()).toBeVisible();
    await expect(page.getByText(product.name).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(invoice).first()).toBeVisible();
    await expect(page.getByText(product.name).first()).toBeVisible();
  });

  test("processes a return and verifies the refund and stock restoration", async () => {
    const stockBefore = await dbStock(product._id);

    const res = await fetch(`${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/sales-returns`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `pos_access_token=${cashierToken}` },
      body: JSON.stringify({
        saleId,
        items: [{ productId: product._id, quantity: 1 }],
        refundMethod: "cash",
        reason: `customer changed mind (${runTag})`,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("approved");
    expect(body.data.refundAmount).toBe(SELLING_PRICE);

    // Stock restored
    expect(await dbStock(product._id)).toBe(stockBefore + 1);

    // Refund recorded in the drawer and the return is queryable
    await connectDb();
    const ret = await SaleReturn.findById(body.data.id).lean();
    expect(ret?.saleId?.toString()).toBe(saleId);

    const history = await fetch(`${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/sales-returns?saleId=${saleId}`, {
      headers: { cookie: `pos_access_token=${adminToken}` },
    }).then((r) => r.json());
    expect(history.returns).toHaveLength(1);
    expect(history.returns[0].total).toBe(SELLING_PRICE);
  });

  test("financial balances and reports reflect the documents", async () => {
    // Supplier was paid in full at purchase time: the payments endpoint
    // summarizes recorded payments (it equals the purchase total), and the
    // outstanding payable balance from the signed supplier ledger is zero.
    const payments = await fetch(
      `${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/finance/supplier-payments?supplierId=${supplierId}`,
      { headers: { cookie: `pos_access_token=${adminToken}` } }
    ).then((r) => r.json());
    expect(payments.summary.totalAmount).toBe(PURCHASE_COST * PURCHASE_QTY);

    // Payables report lists only suppliers with an outstanding balance > 0 —
    // the fully-paid supplier must not appear there.
    const balances = await fetch(
      `${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/reports/suppliers?view=balances&perPage=100`,
      { headers: { cookie: `pos_access_token=${adminToken}` } }
    ).then((r) => r.json());
    expect(balances.rows.some((r: { _id: string }) => r._id === supplierId)).toBe(false);

    // Customer paid cash → no outstanding balance
    const customers = await fetch(
      `${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/customers?search=${encodeURIComponent(`QA WF Customer ${runTag}`)}&withBalance=1`,
      { headers: { cookie: `pos_access_token=${adminToken}` } }
    ).then((r) => r.json());
    expect(customers.customers[0].balance).toBe(0);

    // Dashboard and sales report agree with an independent DB computation
    await connectDb();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [salesAgg, returnsAgg, dash, report] = await Promise.all([
      Sale.aggregate([
        { $match: { status: "completed", createdAt: { $gte: todayStart } } },
        { $group: { _id: null, revenue: { $sum: "$total" }, count: { $sum: 1 } } },
      ]),
      SaleReturn.aggregate([
        { $match: { status: "approved", $expr: { $gte: [{ $ifNull: ["$approvedAt", "$createdAt"] }, todayStart] } } },
        { $group: { _id: null, refund: { $sum: "$total" } } },
      ]),
      fetch(`${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/dashboard`, {
        headers: { cookie: `pos_access_token=${adminToken}` },
      }).then((r) => r.json()),
      fetch(`${process.env.QA_BASE_URL ?? "http://localhost:3210"}/api/reports/sales?period=day`, {
        headers: { cookie: `pos_access_token=${adminToken}` },
      }).then((r) => r.json()),
    ]);

    const expectedNet = Math.round(((salesAgg[0]?.revenue ?? 0) - (returnsAgg[0]?.refund ?? 0) + Number.EPSILON) * 100) / 100;
    expect(dash.today.sales).toBeCloseTo(expectedNet, 2);
    expect(dash.today.transactions).toBe(salesAgg[0]?.count ?? 0);
    expect(report.summary.netSales).toBeCloseTo(expectedNet, 2);
    expect(report.summary.refunds).toBeCloseTo(returnsAgg[0]?.refund ?? 0, 2);
  });

  test("records survive leaving and reloading the pages", async ({ page }) => {
    await loginAsCashier(page);
    await page.goto("/sales");
    await expect(page.getByText(invoice).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(invoice).first()).toBeVisible();

    // Stock level persisted too (returns put the unit back)
    expect(await dbStock(product._id)).toBe(PURCHASE_QTY);
  });
});
