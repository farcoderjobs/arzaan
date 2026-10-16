import { chromium } from "playwright";

/**
 * Offline-first POS end-to-end verification (runs against a live dev server
 * + MongoDB, like scripts/verify_fixes.ts).
 *
 * Scenarios:
 *  1. health endpoint reachable, indicator ONLINE
 *  2. app shell service worker registers
 *  3. going offline flips the indicator + shows the POS banner
 *  4. POS reloads offline and serves the catalog from IndexedDB
 *  5. barcode scan works offline
 *  6. offline sale completes, auto-prints an OFFLINE- receipt once
 *  7. sale is queued (pending badge), visible in the Sync Center offline
 *  8. reconnect → automatic sync → SYNCED with a real invoice number
 *  9. exactly-once server ingestion (extra Sync now + duplicate POST replay)
 * 10. forged oversized offline sale → explicit stock conflict, never accepted
 */

const BASE = process.env.BASE_URL || "http://localhost:3000";
/** Sales created at/after this instant belong to this run and are removed at the end. */
const T0 = new Date();
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

async function salesTotal(page: { request: { get: (url: string) => Promise<{ json: () => Promise<Record<string, number>> }> } }) {
  const res = await page.request.get(`${BASE}/api/sales?page=1&perPage=1`);
  const json = await res.json();
  return json.total ?? -1;
}

(async () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe",
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.addInitScript(() => {
      (window as unknown as { __prints: number }).__prints = 0;
      window.print = () => {
        (window as unknown as { __prints: number }).__prints++;
      };
    });

    // ---------- Setup: login ----------
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.fill('input[id="email"]', "admin@pos.local");
    await page.fill('input[id="password"]', "admin123");
    await page.locator('button[type="submit"]').click();
    let onDashboard = false;
    try {
      await page.waitForURL("**/dashboard", { timeout: 20000 });
      onDashboard = true;
    } catch {
      /* */
    }
    check("login redirects to /dashboard", onDashboard);

    // ---------- 1. health endpoint ----------
    const health = await page.request.get(`${BASE}/api/health`);
    const healthJson = await health.json();
    check("GET /api/health returns ok", health.status() === 200 && healthJson.ok === true);

    // ---------- 2. connection indicator is ONLINE ----------
    await page.goto(`${BASE}/pos`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Cola 500ml", { timeout: 15000 });
    const onlineStatus = await page.locator('[role="status"][data-status]').first().getAttribute("data-status");
    check("header indicator shows ONLINE when connected", onlineStatus === "online", `got ${onlineStatus}`);

    // ---------- 3. service worker registers ----------
    // Wait for registration (fires on window load), then warm the app shell
    // cache with one online reload so offline navigation can be served.
    let swActive = false;
    try {
      await page.waitForFunction(
        () => "serviceWorker" in navigator,
        { timeout: 5000 }
      );
      await page.waitForTimeout(1500);
      swActive = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return !!reg?.active;
      });
    } catch {
      /* */
    }
    check("service worker registered and active", swActive);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Cola 500ml", { timeout: 15000 });
    await page.waitForTimeout(2500); // warm IndexedDB catalog cache (mount effect)

    // ---------- Open a cash register (needed for cash sales) ----------
    const reg = await page.request.post(`${BASE}/api/cash-register`, {
      data: { action: "open", openCash: 500 },
    });
    console.log(`  info: open register status = ${reg.status()}`);

    const serverTotalBefore = await salesTotal(page);

    // Product data used later for idempotency/conflict forgery.
    const barcodeRes = await page.request.get(`${BASE}/api/pos/products?barcode=8901234500011`);
    const barcodeJson = await barcodeRes.json();
    const productId: string = barcodeJson.product._id;
    const sellingPrice: number = barcodeJson.product.sellingPrice;

    // ---------- 4. go offline → indicator + banner ----------
    await context.setOffline(true);
    const offlineDetected = await page
      .waitForSelector('[data-offline-banner]', { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    check("POS shows offline banner", offlineDetected);
    const offlineStatus = await page.locator('[role="status"][data-status]').first().getAttribute("data-status");
    check("header indicator flips to OFFLINE", offlineStatus === "offline", `got ${offlineStatus}`);

    // ---------- 5. offline reload: catalog served from IndexedDB ----------
    await page.waitForTimeout(500);
    let offlineReloadOk = false;
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForSelector('[data-pos]', { timeout: 25000 });
      await page.waitForSelector("text=Cola 500ml", { timeout: 15000 });
      offlineReloadOk = true;
    } catch (e) {
      console.log("  info: offline reload error:", String(e).slice(0, 200));
      console.log("  info: url now:", page.url());
      const body = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => "<n/a>");
      console.log("  info: body:", JSON.stringify(body));
      const ctl = await page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false);
      console.log("  info: sw controlled:", ctl);
      const cacheKeys = await page
        .evaluate(async () => {
          const keys = await caches.keys();
          const out: Record<string, number> = {};
          for (const k of keys) {
            const c = await caches.open(k);
            out[k] = (await c.keys()).length;
          }
          return out;
        })
        .catch(() => ({}));
      console.log("  info: caches:", JSON.stringify(cacheKeys));
      const deep = await page
        .evaluate(() => {
          const main = document.querySelector("main");
          const perf = performance.getEntriesByType("resource").map((r) => r.name);
          return {
            ready: document.readyState,
            htmlHasDataPos: document.documentElement.outerHTML.includes("data-pos"),
            mainHtml: main ? main.innerHTML.slice(0, 500) : "<no main>",
            scriptCount: document.scripts.length,
            resourceCount: perf.length,
            nextChunks: perf.filter((u) => u.includes("_next")).length,
            hasPosChunk: perf.some((u) => u.includes("pos-client") || u.includes("pos_client")),
          };
        })
        .catch((e) => ({ err: String(e) }));
      console.log("  info: deep:", JSON.stringify(deep));
      const posCache = await page
        .evaluate(async () => {
          const keys = await caches.keys();
          const out: string[] = [];
          for (const k of keys) {
            const c = await caches.open(k);
            for (const r of await c.keys()) if (r.url.includes("/pos")) out.push(`${r.method} ${r.url}`);
          }
          return out;
        })
        .catch(() => []);
      console.log("  info: cached /pos entries:", JSON.stringify(posCache));
    }
    check("POS shell reloads while offline (service worker)", offlineReloadOk);
    const offlineGridText = await page.evaluate(() => document.body.innerText);
    check("product grid served from IndexedDB cache", offlineGridText.includes("Cola 500ml"), "no cached products");
    check("offline banner present after reload", offlineGridText.includes("offline"));

    // ---------- 6. barcode scan works offline ----------
    const searchInput = page.locator('input[placeholder*="barcode"]');
    await searchInput.click();
    await searchInput.pressSequentially("8901234500011", { delay: 20 });
    await searchInput.press("Enter");
    await page.waitForTimeout(1200);
    const cartText = await page.evaluate(() => document.body.innerText);
    check("barcode scan adds product to cart offline", /Cart \([1-9]/.test(cartText) && cartText.includes("Cola 500ml"), "not in cart");

    // ---------- 7. offline sale completes + offline receipt ----------
    await page.locator('button:has-text("Payment (F4)")').click();
    await page.waitForSelector('button:has-text("Complete Sale")', { timeout: 8000 });
    await page.locator('button:has-text("Complete Sale")').first().click();
    const saleDone = await page
      .waitForSelector('text=Sale Completed', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check("offline sale completes without network", saleDone);
    await page.waitForTimeout(800);

    const printCalls = await page.evaluate(() => (window as unknown as { __prints: number }).__prints);
    check("offline receipt auto-printed exactly once", printCalls === 1, `print calls = ${printCalls}`);

    const receiptText = await page.evaluate(() => {
      const el = document.querySelector(".print-only");
      return el ? el.textContent ?? "" : "";
    });
    check("receipt rendered with OFFLINE- reference", /OFFLINE-\d{8}-\d{6}/.test(receiptText), receiptText.slice(0, 120));
    check("receipt flagged OFFLINE — PENDING SYNC", receiptText.includes("OFFLINE"));
    check("offline receipt uses Afghani", receiptText.includes("؋"));
    const modalText = await page.evaluate(() => document.body.innerText);
    check("completion modal warns sale is queued for sync", /saved offline|sync automatically/i.test(modalText));

    // ---------- 8. queued: pending badge + Sync Center while offline ----------
    const badge = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[role="status"][data-status]');
          return !!el && /\d/.test(el.textContent ?? "");
        },
        { timeout: 10000 }
      )
      .then(() => true)
      .catch(() => false);
    check("header shows pending count badge", badge);

    await page.goto(`${BASE}/sync`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-sync-center]", { timeout: 15000 });
    await page.waitForTimeout(1000);
    const syncText = await page.evaluate(() => document.body.innerText);
    console.log("  [step8] sync center text:", JSON.stringify(syncText.replace(/\s+/g, " ").slice(0, 700)));
    const idbState = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open("pos-offline");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const rows = await new Promise<Array<{ status: string; ref: string; attempts: number; err: string | null }>>((resolve, reject) => {
        const tx = db.transaction("queue", "readonly");
        const req = tx.objectStore("queue").getAll();
        req.onsuccess = () =>
          resolve(
            (req.result as Array<{ status: string; offlineRef: string; attempts: number; lastError: string | null }>).map((r) => ({
              status: r.status,
              ref: r.offlineRef,
              attempts: r.attempts,
              err: r.lastError,
            }))
          );
        req.onerror = () => reject(req.error);
      });
      db.close();
      return rows;
    });
    console.log("  [step8] queue rows:", JSON.stringify(idbState));
    check("Sync Center lists the queued sale offline (OFFLINE- ref)", /OFFLINE-\d{8}-\d{6}/.test(syncText), "no queued ref");
    check("Sync Center shows queued total in Afghani", syncText.includes("؋"));
    check("Sync Center shows empty-queue absence (≥1 queued)", !syncText.includes("No sales waiting to sync"));

    // Also: cached customers search works offline? (skip — covered by unit tests)

    // ---------- 9. reconnect → automatic sync ----------
    await context.setOffline(false);
    const reconnected = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[role="status"][data-status]');
          if (!el) return false;
          const status = el.getAttribute("data-status");
          if (status === "offline" || status === "syncing") return false;
          // pending badge must be gone (queue drained)
          return !/\d/.test(el.textContent ?? "");
        },
        { timeout: 30000 }
      )
      .then(() => true)
      .catch(() => false);
    check("reconnect → automatic sync drains the queue", reconnected);

    await page.goto(`${BASE}/sync`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-sync-center]", { timeout: 15000 });
    await page.waitForTimeout(1200);
    const syncedText = await page.evaluate(() => document.body.innerText);
    console.log("  [step10] sync center text:", JSON.stringify(syncedText.replace(/\s+/g, " ").slice(0, 700)));
    check("queued sale shows Synced status", /Synced/.test(syncedText), "no Synced chip");
    check("synced row shows a real invoice number", /INV-\d+/.test(syncedText), "no INV- ref");

    // ---------- 10. exactly-once: extra Sync now creates nothing ----------
    const serverTotalAfterSync = await salesTotal(page);
    check(
      "synced sale appears on server exactly once",
      serverTotalAfterSync === serverTotalBefore + 1,
      `before=${serverTotalBefore} after=${serverTotalAfterSync}`
    );

    const syncNowBtn = page.locator('[data-sync-center] button:has-text("Sync now")');
    if ((await syncNowBtn.count()) > 0) {
      await syncNowBtn.click();
      await page.waitForTimeout(2500);
      const totalAfterForce = await salesTotal(page);
      check(
        "extra 'Sync now' does not duplicate the sale",
        totalAfterForce === serverTotalAfterSync,
        `after=${totalAfterForce} expected=${serverTotalAfterSync}`
      );
    } else {
      check("extra 'Sync now' does not duplicate the sale", false, "button not found");
    }

    // ---------- 11. server idempotency: duplicate POST replay ----------
    const dupPayload = {
      // Unique per run: a reused id would (correctly!) short-circuit as alreadySynced.
      clientTransactionId: `e2e-dup-transaction-${Date.now()}`,
      customerId: null,
      items: [{ productId, quantity: 1, unitDiscount: 0 }],
      discount: 0,
      discountType: "amount",
      // Cash may exceed the server total (change is allowed) — overshoot so
      // client-vs-server price/tax differences can never underpay.
      payments: [{ method: "cash", amount: Math.max(1, sellingPrice) * 4, reference: "e2e" }],
      note: "e2e idempotency",
      status: "completed",
    };
    const dup1 = await page.request.post(`${BASE}/api/sync/sale`, { data: dupPayload });
    const dup1Json = await dup1.json();
    check("first /api/sync/sale ingest returns 201", dup1.status() === 201, `got ${dup1.status()}`);
    check("ingest returns invoice number", !!dup1Json?.data?.invoiceNumber, JSON.stringify(dup1Json).slice(0, 160));
    const totalAfterDup1 = await salesTotal(page);

    const dup2 = await page.request.post(`${BASE}/api/sync/sale`, { data: dupPayload });
    const dup2Json = await dup2.json();
    check("replayed /api/sync/sale returns alreadySynced", dup2.status() === 200 && dup2Json.alreadySynced === true, `got ${dup2.status()} ${JSON.stringify(dup2Json).slice(0, 160)}`);
    check(
      "replay does not create a second sale",
      (await salesTotal(page)) === totalAfterDup1,
      `total=${await salesTotal(page)} expected=${totalAfterDup1}`
    );

    // ---------- 12. stock conflict: forged oversized offline sale ----------
    const forgeOk = await page.evaluate(async (pid) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open("pos-offline");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const entry = {
        clientTransactionId: "e2e-conflict-0001",
        status: "PENDING",
        createdAt: Date.now(),
        nextAttemptAt: Date.now(),
        attempts: 0,
        lastError: null,
        offlineRef: "OFFLINE-20261008-999999",
        total: 1,
        itemCount: 1,
        syncedInvoiceNumber: null,
        syncedAt: null,
        payload: {
          customerId: null,
          items: [{ productId: pid, quantity: 9999, unitDiscount: 0 }],
          discount: 0,
          discountType: "amount",
          payments: [{ method: "cash", amount: 1, reference: "" }],
          note: "",
          status: "completed",
          deviceId: "e2e-forgery",
        },
      };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("queue", "readwrite");
        tx.objectStore("queue").put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return true;
    }, productId);
    check("forged oversized offline sale enqueued", forgeOk);

    await page.goto(`${BASE}/sync`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-sync-center]", { timeout: 15000 });
    await page.waitForTimeout(500);
    const btn = page.locator('[data-sync-center] button:has-text("Sync now")');
    await btn.click();
    const conflictShown = await page
      .waitForSelector('text=INSUFFICIENT_STOCK', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check("stock conflict surfaces explicitly (INSUFFICIENT_STOCK)", conflictShown);
    const conflictText = await page.evaluate(() => document.body.innerText);
    check("conflicted sale marked FAILED, not synced", /Failed/.test(conflictText));
    const totalAfterConflict = await salesTotal(page);
    check(
      "conflicted sale is NOT created on the server",
      totalAfterConflict === totalAfterDup1,
      `total=${totalAfterConflict} expected=${totalAfterDup1}`
    );

    // --- Cleanup: remove every sale this run created (stock is movement-derived) ---
    try {
      const { connectDB, disconnectDB } = await import("@/lib/mongodb");
      const { default: mg } = await import("mongoose");
      await connectDB();
      const ids = (await mg.connection.collection("sales").find({ createdAt: { $gte: T0 } }).project({ _id: 1 }).toArray()).map((s) => s._id);
      if (ids.length) {
        await mg.connection.collection("sales").deleteMany({ _id: { $in: ids } });
        await mg.connection.collection("stockmovements").deleteMany({ saleId: { $in: ids } });
        await mg.connection.collection("cashentries").deleteMany({ saleId: { $in: ids } });
        await mg.connection.collection("auditlogs").deleteMany({ entityId: { $in: ids.map(String) } });
      }
      console.log(`cleanup: removed ${ids.length} test sale(s)`);
      await disconnectDB();
    } catch (e) {
      console.log("cleanup failed:", e);
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
