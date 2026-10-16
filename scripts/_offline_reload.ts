/**
 * The exact reported scenario:
 *   1. POS loads online (catalog warms IndexedDB)
 *   2. go offline → make a sale → it queues
 *   3. FULL page refresh while still offline → app must come back with the
 *      queued sale intact
 *   4. reconnect → the queued sale must reach the server
 *
 * The test sale is tagged and removed from the DB afterwards.
 *
 * Run: npx tsx scripts/_offline_reload.ts
 */
import { chromium } from "playwright";
import { connectDB, disconnectDB } from "@/lib/mongodb";
import { Sale, InventoryMovement, CashTransaction } from "@/models";

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
    console.log(`FAIL: ${name} ${extra}`);
  }
}

async function salesTotal(req: {
  get: (url: string) => Promise<{ json: () => Promise<Record<string, unknown>> }>;
}): Promise<number> {
  const res = await req.get(`${BASE}/api/sales?page=1&perPage=1`);
  const json = await res.json();
  return Number(json.total ?? -1);
}

async function cleanup(saleNoteTag: string, since: Date) {
  await connectDB();
  // Primary: the note tag survived the sync. Fallback: the tiny time window
  // this test ran in (no other writer exists during the run).
  let sales = await Sale.find({ note: saleNoteTag }).select("_id");
  if (sales.length === 0) {
    sales = await Sale.find({ createdAt: { $gte: since } }).select("_id invoiceNumber note");
  }
  const ids = sales.map((s) => s._id);
  if (ids.length) {
    await InventoryMovement.deleteMany({ referenceId: { $in: ids } });
    await CashTransaction.deleteMany({ referenceId: { $in: ids } });
    await Sale.deleteMany({ _id: { $in: ids } });
  }
  console.log(`cleanup: removed ${ids.length} test sale(s)`);
  await disconnectDB();
}

(async () => {
  const SALE_NOTE = `repro-offline-reload-${Date.now()}`;
  const T0 = new Date();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    // login
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.fill('input[id="email"]', "admin@pos.local");
    await page.fill('input[id="password"]', "admin123");
    await page.locator('button[type="submit"]').click();
    // 60s: a cold dev server can take a while to compile /dashboard.
    await page.waitForURL("**/dashboard", { timeout: 60000 });

    // POS online → warm catalog + SW
    await page.goto(`${BASE}/pos`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Cola 500ml", { timeout: 20000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Cola 500ml", { timeout: 20000 });
    await page.waitForTimeout(2500);

    const totalBefore = await salesTotal(page.request);

    // ---- go offline, make a sale ----
    await context.setOffline(true);
    await page.waitForSelector('[data-offline-banner]', { timeout: 10000 }).catch(() => undefined);

    const searchInput = page.locator('input[placeholder*="barcode"]');
    await searchInput.click();
    await searchInput.pressSequentially("8901234500011", { delay: 15 });
    await searchInput.press("Enter");
    await page.waitForTimeout(800);

    await page.locator('button:has-text("Payment (F4)")').click();
    await page.waitForSelector('button:has-text("Complete Sale")', { timeout: 8000 });
    // tag the sale note so cleanup can find it
    const noteBox = page.locator('input[placeholder*="ote"], textarea[placeholder*="ote"]').first();
    if ((await noteBox.count()) > 0) await noteBox.fill(SALE_NOTE);
    await page.locator('button:has-text("Complete Sale")').first().click();
    const saleDone = await page
      .waitForSelector("text=Sale Completed", { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check("offline sale completes", saleDone);
    await page.waitForTimeout(500);
    // dismiss receipt/modal if open
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(300);

    // ---- FULL refresh while STILL OFFLINE ----
    await page.reload({ waitUntil: "domcontentloaded", timeout: 25000 });
    const posBack = await page
      .waitForSelector("[data-pos]", { timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    check("POS reloads while offline after the sale", posBack, page.url());
    await page.waitForTimeout(1500);
    const textAfterReload = await page.evaluate(() => document.body.innerText);
    check("catalog still renders offline after refresh", textAfterReload.includes("Cola 500ml"));

    const pendingBadge = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[role="status"][data-status]');
          return !!el && /\d/.test(el.textContent ?? "");
        },
        { timeout: 10000 }
      )
      .then(() => true)
      .catch(() => false);
    check("queued sale still pending after offline refresh", pendingBadge);

    // ---- reconnect → must sync ----
    await context.setOffline(false);
    const drained = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[role="status"][data-status]');
          if (!el) return false;
          const st = el.getAttribute("data-status");
          if (st === "offline" || st === "syncing") return false;
          return !/\d/.test(el.textContent ?? "");
        },
        { timeout: 45000 }
      )
      .then(() => true)
      .catch(() => false);
    check("reconnect drains the queue", drained);

    // server got exactly one sale
    let onServer = false;
    for (let i = 0; i < 20 && !onServer; i++) {
      const total = await salesTotal(page.request);
      onServer = total === totalBefore + 1;
      if (!onServer) await page.waitForTimeout(1000);
    }
    const finalTotal = await salesTotal(page.request);
    check("queued sale synced to server exactly once", finalTotal === totalBefore + 1, `before=${totalBefore} after=${finalTotal}`);

    // Confirm the sale that reached the server came through the offline queue:
    // only /api/sync/sale stores a deviceId on the sale (the online POS path
    // never sends one). Also verify no duplicates appeared in the window.
    await connectDB();
    const windowSales = await Sale.find({ createdAt: { $gte: T0 } }).lean();
    check(
      "synced sale arrived via the offline queue (deviceId set)",
      windowSales.length === 1 && !!windowSales[0]?.deviceId,
      JSON.stringify(windowSales.map((s) => ({ total: s.total, note: s.note, deviceId: s.deviceId })))
    );

    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    await cleanup(SALE_NOTE, T0);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    failed++;
    console.log("FAIL: setup", e);
    try {
      await cleanup("repro-offline-reload", T0);
    } catch {}
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
