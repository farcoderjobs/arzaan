/**
 * UI-level verification of every reported flow, through the real browser UI:
 *   1. sidebar has a Categories link (and it navigates)
 *   2. editing a category updates the same row (no duplicate)
 *   3. editing a supplier updates the same row (no duplicate)
 *   4. editing a brand updates the same row (was: created duplicates) + delete works (was: 405)
 *   5. product deactivate → reactivate round-trip
 *   6. purchase pending → completed via the ✓ button
 *   7. dashboard shows a Refunds KPI
 *   8. Record Payment modal on the customer page succeeds
 * All test rows it creates are removed afterwards.
 *
 * Run: npx tsx scripts/_ui_e2e.ts   (dev server on :3000)
 */
import { chromium } from "playwright";
import { connectDB, disconnectDB } from "@/lib/mongodb";
import {
  Category,
  Supplier,
  Brand,
  Purchase,
  SupplierTransaction,
  InventoryMovement,
  Payment,
  CustomerTransaction,
  Sale,
  CashTransaction,
} from "@/models";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// Typed accessor for loosely-shaped API JSON (repo convention: no explicit any).
type Row = Record<string, unknown>;

const TAG = `ui-${Date.now()}`;
const cleanupIds: Record<string, string[]> = {
  categories: [],
  suppliers: [],
  brands: [],
  purchases: [],
};
let paySaleNote = "";

async function cleanup() {
  await connectDB();
  if (cleanupIds.categories.length) await Category.deleteMany({ _id: { $in: cleanupIds.categories } });
  if (cleanupIds.brands.length) await Brand.deleteMany({ _id: { $in: cleanupIds.brands } });
  if (cleanupIds.purchases.length) {
    await InventoryMovement.deleteMany({ referenceId: { $in: cleanupIds.purchases } });
    await SupplierTransaction.deleteMany({ referenceId: { $in: cleanupIds.purchases } });
    await Purchase.deleteMany({ _id: { $in: cleanupIds.purchases } });
  }
  if (cleanupIds.suppliers.length) {
    await SupplierTransaction.deleteMany({ supplierId: { $in: cleanupIds.suppliers } });
    await Supplier.deleteMany({ _id: { $in: cleanupIds.suppliers } });
  }
  if (paySaleNote) {
    const sales = await Sale.find({ note: paySaleNote }).select("_id");
    const ids = sales.map((s) => s._id);
    if (ids.length) {
      await CustomerTransaction.deleteMany({ referenceId: { $in: ids } });
      await InventoryMovement.deleteMany({ referenceId: { $in: ids } });
      await CashTransaction.deleteMany({ referenceId: { $in: ids } });
      await Sale.deleteMany({ _id: { $in: ids } });
    }
    // ledger rows created by the payment itself reference type "payment"/null — remove by customer window
    console.log(`cleanup: removed ${ids.length} payment-test sale(s)`);
  }
  // Payment (account_payable) docs created by customer payments in this test
  await Payment.deleteMany({ description: /repro|ui-/ });
  console.log("cleanup done");
  await disconnectDB();
}

(async () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    // DB access for setup + cleanup of the payment-modal test data.
    await connectDB();
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const req = page.request;
    const dlg = () => page.locator('[role="dialog"]');

    // ---------- login ----------
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.fill('input[id="email"]', "admin@pos.local");
    await page.fill('input[id="password"]', "admin123");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL("**/dashboard", { timeout: 60000 });
    check("login redirects to /dashboard", true);

    // ---------- 1. sidebar categories link ----------
    await page.waitForSelector("aside", { timeout: 30000 });
    const sidebarHasCategories = await page.locator("aside").getByText("Categories", { exact: true }).count();
    check("sidebar shows the Categories link", sidebarHasCategories > 0);
    await page.locator("aside").getByText("Categories", { exact: true }).first().click();
    await page.waitForURL("**/categories", { timeout: 60000 });
    check("Categories link navigates to /categories", page.url().includes("/categories"), page.url());

    // ---------- 2. category create + edit (no duplicate) ----------
    {
      const before = (await (await req.get(`${BASE}/api/categories?all=1`)).json()) as Row[];
      const name = `ZZ UI Cat ${TAG}`;
      await page.locator('button:has-text("Add Category")').click();
      await dlg().locator('input[placeholder="Category name"]').fill(name);
      await dlg().locator('button:has-text("Create")').click();
      await dlg().waitFor({ state: "hidden", timeout: 20000 });
      const afterCreate = (await (await req.get(`${BASE}/api/categories?all=1`)).json()) as Row[];
      check("UI creates a category", afterCreate.length === before.length + 1, `${before.length} → ${afterCreate.length}`);
      const created = afterCreate.find((c) => c.name === name);
      if (created?._id) cleanupIds.categories.push(created._id as string);

      // edit it through the row click
      await page.locator("tr", { hasText: name }).first().click();
      await dlg().locator('input[placeholder="Category name"]').fill(`${name} v2`);
      await dlg().locator('button:has-text("Save")').click();
      await dlg().waitFor({ state: "hidden", timeout: 20000 });
      const afterEdit = (await (await req.get(`${BASE}/api/categories?all=1`)).json()) as Row[];
      const renamed = afterEdit.find((c) => c._id === created?._id);
      check("editing a category updates it (UI)", !!renamed && renamed.name === `${name} v2`, `name=${renamed?.name}`);
      check("category edit did NOT create a duplicate", afterEdit.length === afterCreate.length, `${afterCreate.length} → ${afterEdit.length}`);
    }

    // ---------- 3. supplier create + edit (no duplicate) ----------
    {
      await page.goto(`${BASE}/suppliers`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('button:has-text("Add Supplier")', { timeout: 60000 });
      const before = (await (await req.get(`${BASE}/api/suppliers?all=1`)).json()) as Row[];
      const name = `ZZ UI Sup ${TAG}`;
      await page.locator('button:has-text("Add Supplier")').click();
      await dlg().locator('input[placeholder="Supplier name"]').fill(name);
      await dlg().locator('button:has-text("Create")').click();
      await dlg().waitFor({ state: "hidden", timeout: 20000 });
      const afterCreate = (await (await req.get(`${BASE}/api/suppliers?all=1`)).json()) as Row[];
      check("UI creates a supplier", afterCreate.length === before.length + 1, `${before.length} → ${afterCreate.length}`);
      const created = afterCreate.find((s) => s.name === name);
      if (created?._id) cleanupIds.suppliers.push(created._id as string);

      await page.locator("tr", { hasText: name }).first().click();
      await dlg().locator('input[placeholder="Supplier name"]').fill(`${name} v2`);
      await dlg().locator('button:has-text("Save")').click();
      await dlg().waitFor({ state: "hidden", timeout: 20000 });
      const afterEdit = (await (await req.get(`${BASE}/api/suppliers?all=1`)).json()) as Row[];
      const renamed = afterEdit.find((s) => s._id === created?._id);
      check("editing a supplier updates it (UI)", !!renamed && renamed.name === `${name} v2`, `name=${renamed?.name}`);
      check("supplier edit did NOT create a duplicate", afterEdit.length === afterCreate.length, `${afterCreate.length} → ${afterEdit.length}`);
    }

    // ---------- 4. brand create + edit + delete (was: duplicate + 405) ----------
    {
      await page.goto(`${BASE}/brands`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('button:has-text("Add Brand")', { timeout: 60000 });
      const before = (await (await req.get(`${BASE}/api/brands?all=1`)).json()) as Row[];
      const name = `ZZ UI Brand ${TAG}`;
      await page.locator('button:has-text("Add Brand")').click();
      await dlg().locator('input[placeholder="Brand name"]').fill(name);
      await dlg().locator('button:has-text("Create")').click();
      await dlg().waitFor({ state: "hidden", timeout: 20000 });
      const afterCreate = (await (await req.get(`${BASE}/api/brands?all=1`)).json()) as Row[];
      check("UI creates a brand", afterCreate.length === before.length + 1, `${before.length} → ${afterCreate.length}`);
      const created = afterCreate.find((b) => b.name === name);

      await page.locator("tr", { hasText: name }).first().click();
      await dlg().locator('input[placeholder="Brand name"]').fill(`${name} v2`);
      await dlg().locator('button:has-text("Save")').click();
      await dlg().waitFor({ state: "hidden", timeout: 20000 });
      const afterEdit = (await (await req.get(`${BASE}/api/brands?all=1`)).json()) as Row[];
      const renamed = afterEdit.find((b) => b._id === created?._id);
      check("editing a brand updates it (UI)", !!renamed && renamed.name === `${name} v2`, `name=${renamed?.name}`);
      check("brand edit did NOT create a duplicate", afterEdit.length === afterCreate.length, `${afterCreate.length} → ${afterEdit.length}`);

      // delete it again (used to405 — API had no DELETE)
      await page.locator("tr", { hasText: `${name} v2` }).first().getByRole("button").last().click();
      await dlg().locator('button:has-text("Delete")').click();
      await dlg().waitFor({ state: "hidden", timeout: 20000 });
      const afterDelete = (await (await req.get(`${BASE}/api/brands?all=1`)).json()) as Row[];
      check("brand delete works from the UI", afterDelete.length === afterCreate.length - 1, `${afterCreate.length} → ${afterDelete.length}`);
    }

    // ---------- 5. product deactivate → reactivate ----------
    {
      await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('button[title="Deactivate"]', { timeout: 60000 });
      const snapshot = (await (await req.get(`${BASE}/api/products?perPage=100`)).json()) as { products: Row[] };
      const statusBefore = new Map<string, string>(
        snapshot.products.map((p) => [String(p._id), String(p.status)] as [string, string])
      );

      await page.locator('button[title="Deactivate"]').first().click();
      await dlg().locator('button:has-text("Deactivate")').last().click();
      await dlg().waitFor({ state: "hidden", timeout: 20000 });
      await page.waitForTimeout(1200);

      let list = (await (await req.get(`${BASE}/api/products?perPage=100`)).json()) as { products: Row[] };
      const flipped = list.products.find((p) => statusBefore.get(String(p._id)) === "active" && String(p.status) !== "active");
      check("product deactivated via the button", !!flipped, JSON.stringify([...statusBefore].filter(([, s]) => s !== "active")));

      // reactivate through the same button
      if (flipped) {
        const reactBtn = page
          .locator("tr")
          .filter({ hasText: String(flipped.name) })
          .locator('button[title="Reactivate"]');
        await reactBtn.first().waitFor({ state: "visible", timeout: 15000 });
        check("reactivate button visible for inactive product", true);
        await reactBtn.first().click();
        await page.waitForTimeout(1500);
        list = (await (await req.get(`${BASE}/api/products?perPage=100`)).json()) as { products: Row[] };
        const target = list.products.find((p) => p._id === flipped._id);
        check("product reactivated again", target?.status === "active", `status=${target?.status}`);
      } else {
        check("reactivate button visible for inactive product", false, "no product flipped to inactive");
        check("product reactivated again", false, "no product flipped to inactive");
      }
    }

    // ---------- 6. purchase pending → completed via UI ----------
    {
      // create a throwaway purchase so real user data isn't changed
      const supRes = await req.post(`${BASE}/api/suppliers`, {
        data: { name: `ZZ UI Pur Sup ${TAG}`, phone: "", email: "", address: "", note: "", status: "active" },
      });
      const supJson = await supRes.json();
      const supId = supJson?.data?.supplier?._id;
      cleanupIds.suppliers.push(supId);
      const prods = (await (await req.get(`${BASE}/api/products?perPage=50`)).json()) as { products: Row[] };
      const prod = prods.products.find((p) => String(p.status) === "active")!;
      const purRes = await req.post(`${BASE}/api/purchases`, {
        data: {
          action: "create",
          supplierId: supId,
          items: [{ productId: prod._id, quantity: 1, purchasePrice: 25, discount: 0, tax: 0 }],
          discount: 0,
          tax: 0,
          paymentMethod: "account",
          paidAmount: 0,
          note: "ui e2e",
        },
      });
      const purJson = await purRes.json();
      const purId = purJson?.data?.purchase?._id;
      const purNo = purJson?.data?.purchase?.purchaseNumber;
      cleanupIds.purchases.push(purId);
      check("test purchase created", !!purId, JSON.stringify(purJson).slice(0, 120));

      await page.goto(`${BASE}/purchases`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("table", { timeout: 60000 });
      const btn = page.locator("tr").filter({ hasText: purNo }).locator('button[title="Mark as completed"]');
      await btn.first().waitFor({ state: "visible", timeout: 30000 });
      check("pending purchase shows the complete (✓) action", (await btn.count()) > 0);
      await btn.first().click();
      await page.waitForTimeout(1500);
      const after = (await (await req.get(`${BASE}/api/purchases?perPage=100`)).json()) as { purchases: Row[] };
      const p = after.purchases.find((x) => x._id === purId);
      check("purchase completed via the UI", p?.status === "completed", `status=${p?.status}`);
    }

    // ---------- 7. dashboard shows refunds ----------
    {
      await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("main", { timeout: 60000 });
      await page.waitForSelector('text=Refunds', { timeout: 45000 }).catch(() => undefined);
      const text = await page.evaluate(() => document.body.innerText);
      // StatCard labels are CSS-uppercased → innerText reports "REFUNDS".
      check("dashboard renders a Refunds KPI", /refunds/i.test(text));
      const dash = (await (await req.get(`${BASE}/api/dashboard?days=30`)).json()) as { range?: Record<string, unknown> };
      check("dashboard API exposes refunds for the range", typeof dash?.range?.refunds === "number", JSON.stringify(dash?.range ?? {}).slice(0, 160));
      check(
        "range refunds equals real returns (30d)",
        Math.abs(Number(dash?.range?.refunds ?? 0) - 10.15) < 0.02,
        `refunds=${String(dash?.range?.refunds)}`
      );
    }

    // ---------- 8. customer Record Payment modal ----------
    {
      paySaleNote = `repro-ui-pay-${TAG}`;
      const custs = (await (await req.get(`${BASE}/api/customers?page=1&perPage=50&withBalance=1`)).json()) as {
        customers: Row[];
      };
      let cust = custs.customers.find((c) => Number(c.balance) > 0);
      if (!cust) {
        // give the first customer a small credit sale so the modal has a balance
        cust = custs.customers[0];
        const prods = (await (await req.get(`${BASE}/api/products?perPage=100`)).json()) as { products: Row[] };
        const prod = prods.products.find(
          (p) => String(p.status) === "active" && Number(p.taxRate ?? 0) === 0 && Number(p.discountPrice ?? 0) === 0
        )!;
        const price = Number(prod.sellingPrice);
        const saleRes = await req.post(`${BASE}/api/sales`, {
          data: {
            clientTransactionId: `repro-ui-pay-${TAG}`,
            customerId: cust._id,
            items: [{ productId: prod._id, quantity: 1, unitDiscount: 0 }],
            discount: 0,
            discountType: "amount",
            payments: [{ method: "credit", amount: price, reference: "" }],
            note: paySaleNote,
            status: "completed",
          },
        });
        check("setup: credit sale created for the payment modal", saleRes.status() === 201, `got ${saleRes.status()}`);
        // refresh so balance reflects the sale just made
        const refreshed = (await (await req.get(`${BASE}/api/customers?page=1&perPage=50&withBalance=1`)).json()) as {
          customers: Row[];
        };
        cust = refreshed.customers.find((c) => c._id === cust!._id) ?? cust;
      }
      const balanceBefore = Number(cust.balance ?? 0);
      check("setup: customer has an outstanding balance", balanceBefore > 0, `balance=${balanceBefore}`);

      await page.goto(`${BASE}/customers/${cust._id}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('button:has-text("Record Payment")', { timeout: 60000 });
      await page.locator('button:has-text("Record Payment")').first().click();
      await dlg().waitFor({ state: "visible", timeout: 15000 });
      const amountInput = dlg().locator('input[type="number"]');
      const prefilled = await amountInput.inputValue();
      check("payment modal prefills the outstanding balance", Number(prefilled) > 0, `amount=${prefilled}`);
      await dlg().locator('button:has-text("Record Payment")').click();
      const closed = await dlg()
        .waitFor({ state: "hidden", timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      check("Record Payment succeeds from the UI", closed);
      const after = (await (await req.get(`${BASE}/api/customers?page=1&perPage=50&withBalance=1`)).json()) as {
        customers: Row[];
      };
      const updated = after.customers.find((c) => c._id === cust!._id);
      check("customer balance is zero after the UI payment", Number(updated?.balance ?? -1) === 0, `balance=${updated?.balance}`);
      // remove the ledger rows this test created (restore original balance)
      await CustomerTransaction.deleteMany({
        customerId: String(cust._id),
        description: /repro|Payment received \(/,
        createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
      });
    }

    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    await cleanup();
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    failed++;
    console.log("FAIL: script crashed", e);
    try {
      await cleanup();
    } catch {}
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
