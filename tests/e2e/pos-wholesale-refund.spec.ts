/**
 * E2E — wholesale pricing in the POS and refunds from inside the POS.
 *
 * Seeding is done through the real APIs; the checkout and refund actions run
 * through the browser UI as the seeded accounts.
 */
import "./env";
import { test, expect, type Page } from "@playwright/test";
import {
  ACCOUNTS,
  api,
  authFor,
  connectDb,
  createProduct,
  dbStock,
  openRegister,
  purgeTag,
  type AuthCtx,
} from "../helpers/qa";

const PASSWORD = process.env.QA_USER_PASSWORD ?? "qa-test-pass-123!";
const BASE_URL = process.env.QA_BASE_URL ?? "http://localhost:3210";

test.describe.serial("POS wholesale & refunds", () => {
  const runTag = `e2e-wh-${Date.now().toString(36)}`;
  let admin: AuthCtx;
  let product: { _id: string; name: string; barcode: string; sku: string };
  let invoice = "";

  test.beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);

    product = await createProduct(admin.token, {
      tag: runTag,
      name: `QA Wholesale ${runTag}`,
      sellingPrice: 40,
      wholesalePrice: 30,
      purchasePrice: 15,
    });
    await api(admin.token).post("/api/inventory", {
      productId: product._id,
      quantity: 10,
      movementType: "ADJUSTMENT_IN",
      reason: "e2e seed",
    });
    await openRegister(admin.token, 0);
  });

  test.afterAll(async () => {
    await purgeTag(runTag).catch(() => undefined);
  });

  async function login(page: Page, email: string) {
    await page.goto("/login");
    await page.fill("#email", email);
    await page.fill("#password", PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 60_000 });
  }

  test("admin checks out at wholesale prices through the POS UI", async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto("/pos");
    await expect(page.locator("[data-pos]")).toBeVisible();

    await page.getByTestId("pricing-mode-wholesale").check();
    await expect(page.getByTestId("pricing-mode-wholesale")).toBeChecked();

    const search = page.getByPlaceholder(/Scan barcode/);
    await search.click();
    await search.fill(product.barcode);
    await search.press("Enter");

    await expect(page.getByText("Wholesale", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: /Payment \(F4\)/ }).click();
    await page.getByRole("button", { name: /Complete Sale/ }).click();
    await expect(page.getByText("Sale Completed").last()).toBeVisible({ timeout: 30_000 });

    invoice = ((await page.locator(".font-mono").filter({ hasText: /INV/ }).first().textContent()) ?? "").trim();
    expect(invoice).toMatch(/^INV-/);

    const list = await fetch(`${BASE_URL}/api/sales?search=${encodeURIComponent(invoice)}`, {
      headers: { cookie: `pos_access_token=${admin.token}` },
    }).then((r) => r.json());
    const saleId = list.sales.find((s: { invoiceNumber: string }) => s.invoiceNumber === invoice)?._id;
    expect(saleId).toBeTruthy();

    const detail = await fetch(`${BASE_URL}/api/sales/${saleId}`, {
      headers: { cookie: `pos_access_token=${admin.token}` },
    }).then((r) => r.json());
    expect(detail.sale.pricingMode).toBe("wholesale");
    expect(detail.sale.total).toBe(30);
    expect(detail.sale.items[0].pricingMode).toBe("wholesale");
    expect(detail.sale.items[0].sellingPrice).toBe(30);
  });

  test("cashier without sales.wholesale cannot switch the wholesale toggle on", async ({ page }) => {
    await login(page, ACCOUNTS.cashier);
    await page.goto("/pos");
    await expect(page.locator("[data-pos]")).toBeVisible();
    // The tier stays discoverable, but the control is disabled and the server
    // rejects a wholesale checkout for a user without sales.wholesale.
    const toggle = page.getByTestId("pricing-mode-wholesale");
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeDisabled();
  });

  test("refunds the original sale from inside the POS", async ({ page }) => {
    const stockBeforeRefund = await dbStock(product._id);

    await login(page, ACCOUNTS.admin);
    await page.goto("/pos");
    await expect(page.locator("[data-pos]")).toBeVisible();

    await page.getByTestId("open-refund").click();
    await page.getByTestId("refund-invoice").fill(invoice);
    await page.getByTestId("refund-lookup").click();

    await expect(page.getByText(invoice).first()).toBeVisible();
    const qty = page.locator('[data-testid^="refund-qty-"]').first();
    await expect(qty).toBeVisible();
    await qty.fill("1");
    await page.getByPlaceholder("e.g. wrong size").fill(`e2e refund ${runTag}`);
    await page.getByTestId("refund-submit").click();

    await expect(page.getByText(/Refund processed|Exchange completed/).last()).toBeVisible({ timeout: 30_000 });

    const lookup = await fetch(
      `${BASE_URL}/api/pos/sales-lookup?invoice=${encodeURIComponent(invoice)}`,
      { headers: { cookie: `pos_access_token=${admin.token}` } }
    ).then((r) => r.json());
    expect(lookup.sale.items[0].returnableQuantity).toBe(0);
    expect(await dbStock(product._id)).toBe(stockBeforeRefund + 1);
  });
});
