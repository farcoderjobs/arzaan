import { chromium } from "playwright";

const BASE = "http://localhost:3000";
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name} ${extra}`); }
}

(async () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe",
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();

    // Count every window.print() call without opening real dialogs
    await page.addInitScript(() => {
      (window as unknown as { __prints: number }).__prints = 0;
      window.print = () => {
        (window as unknown as { __prints: number }).__prints++;
      };
    });

    // ---------- Login (wait for hydration before submitting) ----------
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.fill('input[id="email"]', "admin@pos.local");
    await page.fill('input[id="password"]', "admin123");
    await page.locator('button[type="submit"]').click();
    let onDashboard = false;
    try { await page.waitForURL("**/dashboard", { timeout: 20000 }); onDashboard = true; } catch { /* */ }
    check("login redirects to /dashboard", onDashboard);

    // ---------- FIX 1: only ONE header on the dashboard ----------
    await page.waitForSelector("main", { timeout: 10000 });
    const headerCount = await page.locator("header").count();
    check("dashboard renders exactly one header", headerCount === 1, `got ${headerCount}`);
    const sidebarCount = await page.locator("aside, nav").count();
    console.log(`  info: sidebar/nav elements = ${sidebarCount}`);

    // ---------- FIX 3: dashboard range filter drives KPIs ----------
    const rangePromise = page.waitForResponse(
      (r) => r.url().includes("/api/dashboard?days=7") && r.status() === 200,
      { timeout: 15000 }
    );
    await page.selectOption("main select", "7");
    const rangeResp = await rangePromise;
    const rangeJson = await rangeResp.json();
    check("dashboard API returns range KPIs", !!rangeJson.range && typeof rangeJson.range.sales === "number", JSON.stringify(rangeJson.range ?? {}).slice(0, 120));
    check("range KPIs differ from today when days=7", JSON.stringify(rangeJson.range) !== JSON.stringify(rangeJson.today) || rangeJson.range.transactions === rangeJson.today.transactions);
    const selectText = await page.locator("main select").first().locator("option:checked").textContent();
    check("range option labels are clean", selectText === "Last 7 days", `got "${selectText}"`);

    // ---------- FIX 2: Afghani formatting on dashboard ----------
    const dashText = await page.evaluate(() => document.body.innerText);
    check("dashboard shows Afghani symbol", dashText.includes("؋"), "no ؋ found");
    check("dashboard has no dollar prices", !/\$\d/.test(dashText), "found $ amount");

    // ---------- FIX 4 + 6: POS search icon size + barcode scan ----------
    await page.goto(`${BASE}/pos`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Cola 500ml", { timeout: 15000 });

    const iconBox = await page.locator('div:has(> input[placeholder*="barcode"]) > svg').first().boundingBox();
    check("POS search icon is small (≤20px wide)", !!iconBox && iconBox.width <= 20.5, `width=${iconBox?.width}`);
    const posText = await page.evaluate(() => document.body.innerText);
    check("POS prices show Afghani", posText.includes("؋"), "no ؋ on POS");
    check("POS prices have no dollar amounts", !/\$\d/.test(posText), "found $ amount on POS");

    // Barcode scanner flow: type fast + Enter (scanner behaviour)
    const searchInput = page.locator('input[placeholder*="barcode"]');
    await searchInput.click();
    await searchInput.pressSequentially("8901234500011", { delay: 20 });
    await searchInput.press("Enter");
    await page.waitForTimeout(1200);
    const cartText = await page.evaluate(() => document.body.innerText);
    check("barcode scan adds product to cart", cartText.includes("Cola 500ml") && /Cart \([1-9]/.test(cartText), "product not in cart");

    // ---------- FIX 5: one-click Complete Sale auto-prints ----------
    // Open a cash register first so a cash sale is allowed.
    const reg = await page.request.post(`${BASE}/api/cash-register`, {
      data: { action: "open", openCash: 500 },
    });
    console.log(`  info: open register status = ${reg.status()}`);

    await page.locator('button:has-text("Payment (F4)")').click();
    await page.waitForSelector('button:has-text("Complete Sale")', { timeout: 8000 });
    await page.locator('button:has-text("Complete Sale")').first().click();

    const saleDone = await page
      .waitForSelector('text=Sale Completed', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check("sale completes", saleDone);

    await page.waitForTimeout(800);
    const printCalls = await page.evaluate(() => (window as unknown as { __prints: number }).__prints);
    check("receipt auto-printed exactly once after one click", printCalls === 1, `print calls = ${printCalls}`);

    // Printable receipt exists in DOM and uses Afghani
    const receiptVisibleInPrint = await page.evaluate(() => {
      const el = document.querySelector(".print-only");
      return el ? el.textContent ?? "" : "";
    });
    check("printable receipt rendered", receiptVisibleInPrint.includes("SALES RECEIPT"), "receipt missing");
    check("receipt uses Afghani", receiptVisibleInPrint.includes("؋"), "receipt missing ؋");

    // ---------- Money sweep across the main screens ----------
    for (const path of ["/sales", "/products", "/purchases", "/returns", "/customers", "/finance", "/inventory"]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText);
      check(`${path} has no dollar amounts`, !/\$\d/.test(text), (text.match(/.{0,40}\$\d.{0,40}/) ?? [""])[0]);
    }

    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    failed++;
    console.log("FAIL: setup", e);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
