/**
 * Reproduces the reported "queued sales never reach the DB after the system
 * is online" on long-running POS terminals:
 *
 *  Scenario 1 — access token expired while offline (7-day TTL, terminal left
 *    signed in). The sync engine must rotate the session via the refresh
 *    cookie and deliver the sale automatically.
 *  Scenario 2 — refresh token dead too (both cookies expired). The entry must
 *    stay PENDING with a clear message (NOT stranded as FAILED) and drain
 *    automatically once the cashier logs back in.
 *
 * Each scenario logs in through the real UI, makes a real offline POS sale,
 * and verifies the outcome in the DB. Test sales are removed afterwards.
 *
 * Run: npx tsx scripts/_sync_auth_e2e.ts   (dev server on :3000)
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Types } from "mongoose";
import jwt from "jsonwebtoken";
import { connectDB, disconnectDB } from "@/lib/mongodb";
import { Sale, InventoryMovement, CashTransaction } from "@/models";
import "@/config/env"; // side effect: loads .env (JWT_SECRET)

const BASE = process.env.BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe";
const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error("JWT_SECRET missing — is .env loaded?");

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Overwrites auth cookies with already-expired JWTs for the same user. */
async function expireCookies(context: BrowserContext, opts: { refresh: boolean }) {
  const cookies = await context.cookies(BASE);
  const access = cookies.find((c) => c.name === "pos_access_token");
  const payload = jwt.decode(access?.value ?? "") as { sub?: string; role?: string } | null;
  if (!payload?.sub) throw new Error("could not decode access token");
  await context.addCookies([
    { name: "pos_access_token", value: jwt.sign({ sub: payload.sub, role: payload.role }, SECRET!, { expiresIn: -60 }), url: BASE },
  ]);
  if (opts.refresh) {
    await context.addCookies([
      { name: "pos_refresh_token", value: jwt.sign({ sub: payload.sub, type: "refresh" }, SECRET!, { expiresIn: -60 }), url: BASE },
    ]);
  }
  return access?.value ?? "";
}

async function loginUI(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.fill('input[id="email"]', "admin@pos.local");
  await page.fill('input[id="password"]', "admin123");
  await page.locator('button[type="submit"]').click();
  // 60s: a cold dev server can take a while to compile /dashboard.
  await page.waitForURL("**/dashboard", { timeout: 60000 });
}

/** POS: warm catalog, then make one offline cash sale (Cola 500ml). */
async function offlineSale(page: Page) {
  await page.goto(`${BASE}/pos`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Cola 500ml", { timeout: 30000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Cola 500ml", { timeout: 30000 });
  await page.waitForTimeout(2000);

  await page.context().setOffline(true);
  await page.waitForSelector("[data-offline-banner]", { timeout: 10000 }).catch(() => undefined);

  const searchInput = page.locator('input[placeholder*="barcode"]');
  await searchInput.click();
  await searchInput.pressSequentially("8901234500011", { delay: 15 });
  await searchInput.press("Enter");
  await page.waitForTimeout(800);

  await page.locator('button:has-text("Payment (F4)")').click();
  await page.waitForSelector('button:has-text("Complete Sale")', { timeout: 8000 });
  await page.locator('button:has-text("Complete Sale")').first().click();
  const done = await page
    .waitForSelector("text=Sale Completed", { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("offline sale completes and queues", done);
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(300);
}

/** Polls the DB for offline-synced sales (deviceId is only set by /api/sync/sale). */
async function syncedSalesSince(since: Date) {
  return Sale.find({ createdAt: { $gte: since }, deviceId: { $ne: null } }).lean();
}

async function removeSales(sales: Array<{ _id: Types.ObjectId }>) {
  const ids = sales.map((s) => s._id);
  if (!ids.length) return;
  await InventoryMovement.deleteMany({ referenceId: { $in: ids } });
  await CashTransaction.deleteMany({ referenceId: { $in: ids } });
  await Sale.deleteMany({ _id: { $in: ids } });
}

(async () => {
  await connectDB();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });

    // ================================================================
    // Scenario 1 — access token expired while offline
    // ================================================================
    console.log("\n--- scenario 1: expired access token, valid refresh token ---");
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginUI(page);

      const T0 = new Date();
      await offlineSale(page);

      const oldAccess = await expireCookies(context, { refresh: false });
      await context.setOffline(false);

      // The engine should post → 401 → refresh session → retry → 201.
      let found: Awaited<ReturnType<typeof syncedSalesSince>> = [];
      for (let i = 0; i < 24 && found.length === 0; i++) {
        await sleep(2500);
        found = await syncedSalesSince(T0);
      }
      check("queued sale syncs despite expired access token", found.length === 1, `sales in window=${found.length}`);
      check("sale carries deviceId (arrived via the offline queue)", !!found[0]?.deviceId);

      const cookies = await context.cookies(BASE);
      const newAccess = cookies.find((c) => c.name === "pos_access_token")?.value ?? "";
      check("session was rotated by the refresh flow", !!newAccess && newAccess !== oldAccess);

      const badge = await page.evaluate(() => document.querySelector('[role="status"][data-status]')?.textContent ?? "");
      check("pending badge drained", !/\d/.test(badge), `badge=${badge}`);

      await removeSales(found);
      await context.close();
    }

    // ================================================================
    // Scenario 2 — both tokens dead; sale must survive until re-login
    // ================================================================
    console.log("\n--- scenario 2: both tokens expired → drains after re-login ---");
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginUI(page);

      const T0 = new Date();
      await offlineSale(page);

      await expireCookies(context, { refresh: true });
      await context.setOffline(false);

      // Reconnect sync must NOT deliver (no valid session) and must NOT
      // strand the entry as FAILED — it stays PENDING with backoff.
      await sleep(10_000);
      const beforeLogin = await syncedSalesSince(T0);
      check("sale not delivered while signed out", beforeLogin.length === 0, `sales=${beforeLogin.length}`);

      // Cashier logs back in through the normal UI.
      await loginUI(page);

      // Backoff is 30s after the first failed attempt and the sweep runs
      // every 60s, so the entry becomes due within ~2 minutes of re-login.
      let found: Awaited<ReturnType<typeof syncedSalesSince>> = [];
      for (let i = 0; i < 40 && found.length === 0; i++) {
        await sleep(5000);
        found = await syncedSalesSince(T0);
      }
      check("queued sale drains automatically after re-login", found.length === 1, `sales in window=${found.length}`);

      await removeSales(found);
      await context.close();
    }

    console.log(`\nRESULT: ${passed} passed, ${failed} failed (test sales removed)`);
    await disconnectDB();
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    failed++;
    console.log("FAIL: script crashed", e);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
