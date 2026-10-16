/**
 * Smoke test for the batch of reported bugs:
 *  1. Concurrent API 500s (MongoNotConnectedError race)
 *  2. GET /api/brands 403 (missing brands.* permissions)
 *  3. reports/* "Functions cannot be passed directly to Client Components"
 *  4. Sidebar overlapping content
 *  5. POS discount percentage math
 *  6. View / Print receipt flow
 *  7. Purchases modal not scrolling
 *
 * Run: npx tsx scripts/smoke-fixes.ts   (dev server on :3001)
 */
import { chromium } from "playwright";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const CHROME =
  "C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name} ${extra}`);
  }
}

const serverErrors: string[] = [];
const consoleErrors: string[] = [];

const money = (text: string) => Number(text.replace(/[^0-9.]/g, ""));

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // esbuild's keepNames inserts __name() calls into evaluated functions;
  // provide the shim in the page context.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__name = (f: unknown) => f;
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`);
  });

  try {
    // ---------- Login ----------
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForFunction(
      `(() => { const b = document.querySelector('button[type="submit"]'); return b && Object.keys(b).some((k) => k.startsWith('__reactProps$')); })()`
    );
    await page.fill('input[id="email"]', "admin@pos.local");
    await page.fill('input[id="password"]', "admin123");
    await page.click('button[type="submit"]');
    let onDashboard = true;
    try {
      await page.waitForURL("**/dashboard", { timeout: 60_000 });
    } catch {
      onDashboard = false;
    }
    check("login redirects to /dashboard", onDashboard, page.url());

    // ---------- 1. Concurrent API batch (was: 500 MongoNotConnectedError) ----------
    const apis = [
      "/api/brands",
      "/api/categories",
      "/api/products?page=1&perPage=15&search=&sku=&status=",
      "/api/suppliers",
      "/api/purchases?page=1&perPage=15&status=&search=",
      "/api/sales/filters",
      "/api/sales?page=1&perPage=15",
      "/api/pos/customers?limit=200",
      "/api/finance/cash-transactions?page=1&perPage=20",
      "/api/roles",
      "/api/audit-logs?page=1&perPage=25&period=week",
      "/api/dashboard",
    ];
    const statuses = (await page.evaluate(async (urls) => {
      const results = await Promise.all(
        urls.map(async (u) => {
          const t = Date.now();
          try {
            const r = await fetch(u);
            return `${r.status} ${u} ${Date.now() - t}ms`;
          } catch (e) {
            return `ERR ${u} ${String(e)}`;
          }
        })
      );
      return results;
    }, apis)) as string[];
    console.log("  api batch:\n   " + statuses.join("\n   "));
    check(
      "all concurrent API requests return 200",
      statuses.every((s) => s.startsWith("200 ")),
      statuses.filter((s) => !s.startsWith("200 ")).join(" | ")
    );

    // ---------- 2. Brands page (was: 403) ----------
    const brandsRes = await page.evaluate(() => fetch("/api/brands").then((r) => r.status));
    check("GET /api/brands is 200", brandsRes === 200, String(brandsRes));
    await page.goto(`${BASE}/brands`, { waitUntil: "networkidle", timeout: 90_000 });
    const brandsBody = await page.textContent("body");
    check(
      "/brands page has no load error",
      !brandsBody!.includes("Failed to load brands"),
      "toast present"
    );

    // ---------- 3. Reports pages (was: functions-to-client-component error) ----------
    for (const rep of ["products", "inventory", "purchases", "customers", "suppliers"]) {
      const res = await page.goto(`${BASE}/reports/${rep}`, {
        waitUntil: "networkidle",
        timeout: 90_000,
      });
      const body = (await page.textContent("body")) ?? "";
      check(
        `/reports/${rep} renders`,
        res?.status() === 200 &&
          !body.includes("Functions cannot be passed") &&
          !body.includes("Application error") &&
          body.includes("Export CSV"),
        `status=${res?.status()}`
      );
    }

    // ---------- 4. Sidebar does not overlap content (checked on a report page) ----------
    const layout = (await page.evaluate(() => {
      const aside = document.querySelector("aside");
      const main = document.querySelector("main");
      if (!aside || !main) return null;
      const a = aside.getBoundingClientRect();
      const m = main.getBoundingClientRect();
      return {
        asideRight: a.right,
        mainLeft: m.left,
        docOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    })) as { asideRight: number; mainLeft: number; docOverflowX: boolean } | null;
    check("sidebar + layout measured", layout !== null);
    if (layout) {
      check(
        "content starts right of sidebar (no overlap)",
        layout.mainLeft >= layout.asideRight - 1,
        JSON.stringify(layout)
      );
      check("no horizontal page overflow", !layout.docOverflowX);
    }

    // ---------- 5. POS discount percentage ----------
    await page.goto(`${BASE}/pos`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.locator("button.h-28:not([disabled])").first().waitFor({ timeout: 30_000 });
    await page.locator("button.h-28:not([disabled])").first().click();
    await page.waitForTimeout(300);

    const readTotals = () =>
      page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll("span"));
        const rowValue = (label: string) => {
          const lab = spans.find((s) => s.textContent === label);
          return lab?.parentElement?.lastElementChild?.textContent ?? "";
        };
        return {
          subtotal: rowValue("Subtotal"),
          tax: rowValue("Tax"),
          total: rowValue("Total"),
          discount:
            document.querySelector("span.w-16.text-right.text-red-500")?.textContent ?? "",
        };
      });

    const before = await readTotals();
    const subtotal = money(before.subtotal);
    check("cart has subtotal after adding a product", subtotal > 0, JSON.stringify(before));

    await page.locator("input.w-20").first().fill("10");
    await page.locator("select").filter({ has: page.locator('option[value="percent"]') }).selectOption("percent");
    await page.waitForTimeout(300);
    const after = await readTotals();
    const disc = money(after.discount);
    const expected = Math.round(subtotal * 0.1 * 100) / 100;
    check(
      "10% discount displays 10% of subtotal",
      Math.abs(disc - expected) <= 0.02,
      `subtotal=${subtotal} discount=${disc} expected=${expected} raw=${after.discount}`
    );
    const totalNow = money(after.total);
    const taxNow = money(after.tax);
    const implied = Math.round((subtotal - disc + taxNow) * 100) / 100;
    check(
      "total = subtotal − discount + tax",
      Math.abs(totalNow - implied) <= 0.02,
      `total=${totalNow} implied=${implied}`
    );

    // ---------- 6. Complete a sale + View / Print Receipt ----------
    // Open the cash register so a cash sale is accepted.
    const reg = (await page.evaluate(async () => {
      const r = await fetch("/api/cash-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open", openCash: 100 }),
      });
      return `${r.status} ${(await r.text()).slice(0, 160)}`;
    })) as string;
    console.log(`  open register: ${reg}`);
    check("cash register open (or already open)", reg.startsWith("2") || reg.includes("already"), reg);

    await page.getByRole("button", { name: /F4/ }).click();
    await page.getByRole("dialog").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: /F9/ }).click();
    await page.getByText("SALES RECEIPT", { exact: false }).first().waitFor({ timeout: 5_000 }).catch(() => {});
    const saleModal = await page
      .getByText("Sale Completed", { exact: false })
      .first()
      .waitFor({ timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    check("sale completes → 'Sale Completed' modal", saleModal);

    const receiptBtn = page.getByRole("button", { name: "View / Print Receipt" });
    const receiptVisible = await receiptBtn.isVisible().catch(() => false);
    check("'View / Print Receipt' button shown", receiptVisible);

    let navigated = false;
    if (receiptVisible) {
      await Promise.all([
        page.waitForURL(/\/sales\/[a-z0-9]+/i, { timeout: 30_000 }).then(() => (navigated = true)),
        receiptBtn.click(),
      ]).catch(() => {});
    }
    check("receipt button navigates to /sales/<id>", navigated && /\/sales\//.test(page.url()), page.url());

    const receiptOk = await page
      .waitForSelector(".print-only", { state: "attached", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const detailBody = (await page.textContent("body")) ?? "";
    check(
      "sale detail shows printable receipt + Print button",
      receiptOk && detailBody.includes("Print Receipt") && !detailBody.includes("Sale not found")
    );

    // ---------- 7. Purchases modal scrolls ----------
    await page.goto(`${BASE}/purchases`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.getByRole("button", { name: /New Purchase/ }).click();
    await page.getByRole("dialog").waitFor({ timeout: 15_000 });
    for (let i = 0; i < 6; i++) {
      await page.getByRole("button", { name: "Add Item" }).click();
    }
    await page.waitForTimeout(300);
    const modalMetrics = (await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]') as HTMLElement | null;
      if (!dlg) return null;
      const body = dlg.querySelector("div.overflow-y-auto") as HTMLElement | null;
      const selects = dlg.querySelectorAll("select");
      const productSelect = selects[1] ?? null; // 0 = supplier, 1 = first item product
      return {
        dlgHeight: dlg.getBoundingClientRect().height,
        viewport: window.innerHeight,
        scrollable: body ? body.scrollHeight > body.clientHeight : false,
        productOptions: productSelect ? productSelect.querySelectorAll("option").length : 0,
      };
    })) as { dlgHeight: number; viewport: number; scrollable: boolean; productOptions: number } | null;
    check("purchase modal measured", modalMetrics !== null);
    if (modalMetrics) {
      check(
        "modal fits viewport (max-height applied)",
        modalMetrics.dlgHeight <= modalMetrics.viewport,
        JSON.stringify(modalMetrics)
      );
      check("modal body is scrollable", modalMetrics.scrollable);
      const scrolled = await page.evaluate(() => {
        const body = document.querySelector('[role="dialog"] div.overflow-y-auto') as HTMLElement | null;
        if (!body) return -1;
        body.scrollTop = 250;
        return body.scrollTop;
      });
      check("modal body scrolls down", scrolled > 0, `scrollTop=${scrolled}`);
      check(
        "product dropdown has options (shape fix)",
        modalMetrics.productOptions > 1,
        `options=${modalMetrics.productOptions}`
      );
    }
  } catch (e) {
    failed++;
    console.log("FAIL: smoke script crashed", e);
  } finally {
    await browser.close();
  }

  const badErrors = consoleErrors.filter((e) =>
    /Functions cannot be passed|MongoNotConnected|Hydration failed|Unhandled Runtime/.test(e)
  );
  check("no critical console errors", badErrors.length === 0, badErrors.slice(0, 5).join(" | "));
  check("no HTTP 5xx responses during session", serverErrors.length === 0, serverErrors.slice(0, 8).join(" | "));
  if (consoleErrors.length) {
    console.log(`\n  (${consoleErrors.length} console errors total, sample:)`);
    consoleErrors.slice(0, 5).forEach((e) => console.log("   - " + e.slice(0, 200)));
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
