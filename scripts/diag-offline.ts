/** Diagnose the POS offline catalog cache. Run: npx tsx scripts/diag-offline.ts */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe";

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    // esbuild (tsx) keeps function names by inserting __name() calls.
    (window as unknown as Record<string, unknown>).__name = (f: unknown) => f;
    window.addEventListener("error", (e) => {
      console.error(`[probe] error ${e.message} @ ${e.filename}:${e.lineno}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      const r = e.reason as { stack?: string; message?: string } | undefined;
      console.error(`[probe] unhandledrejection ${r?.stack ?? r?.message ?? String(e.reason)}`);
    });
    // Trace how far Next's hydration bootstrap gets.
    const origAddEventListener = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, fn: unknown, opts?: unknown) => {
      if (type === "DOMContentLoaded") console.log(`[probe] ${Date.now()} addEventListener(DCL) readyState=${document.readyState}`);
      return origAddEventListener(type, fn as EventListener, opts as AddEventListenerOptions | undefined);
    }) as typeof window.addEventListener;
    const origSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((fn: unknown, ms?: number, ...args: unknown[]) => {
      const src = typeof fn === "function" ? String(fn) : "";
      if (src.includes("initialServerDataWriter") || src.includes("initialServerDataLoaded")) {
        console.log(`[probe] ${Date.now()} schedule flight-close timer readyState=${document.readyState}`);
      }
      return origSetTimeout(fn as () => void, ms, ...args);
    }) as typeof window.setTimeout;
  });
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || /offline|cache|indexeddb|idb|error/i.test(t)) {
      console.log(`  console[${m.type()}]: ${t.slice(0, 300)}`);
    }
  });
  page.on("pageerror", (e) => console.log(`  pageerror: ${String(e).slice(0, 300)}`));

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.fill('input[id="email"]', "admin@pos.local");
  await page.fill('input[id="password"]', "admin123");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/dashboard", { timeout: 60000 });

  // Track which scripts the engine actually parses/executes.
  const cdp = await context.newCDPSession(page);
  let parsed: string[] = [];
  let sockets: string[] = [];
  await cdp.send("Debugger.enable");
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketCreated", (e: { url: string }) => sockets.push(e.url.replace(/^ws?:\/\/[^/]+/, "")));
  cdp.on("Debugger.scriptParsed", (e: { url?: string }) => {
    if (e.url) parsed.push(e.url.replace(/^https?:\/\/[^/]+/, ""));
  });

  await page.goto(`${BASE}/pos`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Cola 500ml", { timeout: 20000 }).catch(() => console.log("  (Cola not visible online)"));
  await page.waitForTimeout(4000);

  const onlineHydrated = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    return {
      buttons: btns.length,
      hydrated: btns.filter((b) => Object.keys(b).some((k) => k.startsWith("__reactProps$"))).length,
      hasFlight: (window as unknown as Record<string, unknown>).__next_f !== undefined,
    };
  });
  console.log("online hydration:", JSON.stringify(onlineHydrated));

  const onlineHtml = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const scripts = Array.from(document.querySelectorAll("script"));
    return {
      htmlLen: html.length,
      flightPushCount: (html.match(/__next_f\.push/g) ?? []).length,
      inlineScripts: scripts.filter((s) => !s.src).length,
      externalScripts: scripts.filter((s) => s.src).length,
      flightLen: ((window as unknown as Record<string, unknown>).__next_f as unknown[] | undefined)?.length ?? -1,
      inlineTexts: scripts.filter((s) => !s.src).map((s) => (s.textContent ?? "").slice(0, 120)),
      srcs: scripts.filter((s) => s.src).map((s) => s.src.replace(/^https?:\/\/[^/]+/, "")),
      links: Array.from(document.querySelectorAll('link[rel="modulepreload"],link[rel="preload"][as="script"]')).map((l) =>
        (l as HTMLLinkElement).href.replace(/^https?:\/\/[^/]+/, "")
      ),
    };
  });
  console.log("online html:", JSON.stringify(onlineHtml, null, 2));
  console.log("online parsed scripts:", JSON.stringify(parsed.filter((u) => u.includes("_next")), null, 2));
  console.log("online websockets:", JSON.stringify(sockets, null, 2));
  parsed = [];

  const diag = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    // raw API shape
    try {
      const r = await fetch("/api/pos/products?page=1&perPage=100");
      const j = await r.json();
      out.apiStatus = r.status;
      out.apiKeys = Object.keys(j);
      out.apiProductCount = Array.isArray(j.products) ? j.products.length : -1;
      out.apiCategories = Array.isArray(j.categories) ? j.categories.length : -1;
      out.apiTotalPages = (j as { totalPages?: number }).totalPages;
      out.apiFirstProduct = Array.isArray(j.products) && j.products[0] ? Object.keys(j.products[0]) : null;
    } catch (e) {
      out.apiError = String(e);
    }
    // indexeddb state
    try {
      const dbs = (await indexedDB.databases?.()) ?? [];
      out.databases = dbs.map((d) => `${d.name}@${d.version}`);
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open("pos-offline");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onupgradeneeded = () => reject(new Error("db would upgrade (does not exist yet)"));
      });
      out.stores = Array.from(db.objectStoreNames);
      const count = (store: string) =>
        new Promise<number>((resolve, reject) => {
          const tx = db.transaction(store, "readonly");
          const req = tx.objectStore(store).count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      out.productRows = await count("products");
      out.categoryRows = await count("categories");
      out.queueRows = await count("queue");
      db.close();
    } catch (e) {
      out.idbError = String(e);
    }
    return out;
  });
  console.log("diagnostics:", JSON.stringify(diag, null, 2));

  // ---------- go offline and reload ----------
  const netLog: string[] = [];
  page.on("console", (m) => {
    netLog.push(`${Date.now()} console[${m.type()}] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => netLog.push(`${Date.now()} pageerror ${String(e).slice(0, 300)}`));
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("_next") || u.includes("/pos") || u.includes("/api/")) netLog.push(`${Date.now()} res ${r.status()} ${u.replace(BASE, "")}`);
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (u.includes("HMR") || u.includes("hmr")) return;
    netLog.push(`${Date.now()} FAILED ${r.method()} ${u.replace(BASE, "")} ${r.failure()?.errorText}`);
  });
  await context.setOffline(true);
  await page.waitForTimeout(500);
  parsed = [];
  sockets = [];
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => console.log("  reload error:", String(e).slice(0, 200)));
  await page.waitForTimeout(6000);
  console.log("offline parsed scripts:", JSON.stringify(parsed.filter((u) => u.includes("_next")), null, 2));
  console.log("offline websockets:", JSON.stringify(sockets, null, 2));

  const offline = await page.evaluate(() => {
    const body = document.body.innerText;
    const grid = document.querySelector("[data-pos]");
    const skel = document.querySelector(".animate-pulse");
    return {
      hasPos: !!grid,
      textLen: body.length,
      hasCola: body.includes("Cola 500ml"),
      skeleton: !!skel,
      skeletonWhere: skel ? (skel.parentElement?.className ?? "") : null,
      skeletonHtml: skel ? skel.outerHTML.slice(0, 300) : null,
      noData: body.includes("No products") || body.includes("no data"),
      snippet: body.slice(0, 600),
      buttons: document.querySelectorAll("button").length,
    };
  });
  console.log("offline reload:", JSON.stringify(offline, null, 2));

  const htmlDiag = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const scripts = Array.from(document.querySelectorAll("script"));
    return {
      htmlLen: html.length,
      flightPushCount: (html.match(/__next_f\.push/g) ?? []).length,
      inlineScripts: scripts.filter((s) => !s.src).length,
      externalScripts: scripts.filter((s) => s.src).length,
      scriptTypes: Array.from(new Set(scripts.map((s) => s.type || "(none)"))),
      firstInlineLen: (scripts.find((s) => !s.src)?.textContent ?? "").length,
      inlineTexts: scripts.filter((s) => !s.src).map((s) => (s.textContent ?? "").slice(0, 120)),
      srcs: scripts.filter((s) => s.src).map((s) => s.src.replace(/^https?:\/\/[^/]+/, "")),
      links: Array.from(document.querySelectorAll('link[rel="modulepreload"],link[rel="preload"][as="script"]')).map((l) =>
        (l as HTMLLinkElement).href.replace(/^https?:\/\/[^/]+/, "")
      ),
      hasTurboChunkTag: html.includes("turbopack"),
      bodyHasPos: document.body.innerHTML.includes("data-pos"),
    };
  });
  console.log("offline html:", JSON.stringify(htmlDiag, null, 2));

  const cachedDiag = await page.evaluate(async () => {
    const out: Array<Record<string, unknown>> = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        if (!req.url.includes("/pos")) continue;
        const res = await cache.match(req);
        if (!res) continue;
        const text = await res.clone().text();
        out.push({
          cache: name,
          url: req.url,
          len: text.length,
          pushes: (text.match(/__next_f\.push/g) ?? []).length,
          scripts: (text.match(/<script/g) ?? []).length,
          hasCola: text.includes("Cola"),
        });
      }
    }
    return out;
  });
  console.log("cached /pos entries:", JSON.stringify(cachedDiag, null, 2));

  const probe = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    const btns = Array.from(document.querySelectorAll("button"));
    out.buttons = btns.length;
    out.hydratedButtons = btns.filter((b) => Object.keys(b).some((k) => k.startsWith("__reactProps$"))).length;
    const win = window as unknown as Record<string, unknown>;
    out.hasFlight = win.__next_f !== undefined;
    out.flightLen = (win.__next_f as unknown[] | undefined)?.length ?? -1;
    out.hasTurbopack = "__turbopack_require__" in window || "TURBOPACK" in window;
    out.windowNext = win.next !== undefined ? JSON.stringify(Object.keys(win.next as object)) : "absent";
    out.windowKeys = Object.keys(window).filter((k) => k.startsWith("__") || k === "next").slice(0, 40);
    out.docReactKeys = Object.keys(document).filter((k) => k.startsWith("__react"));
    out.htmlReactKeys = Object.keys(document.documentElement).filter((k) => k.startsWith("__react"));
    out.devtools = win.__next_devtools__ !== undefined ? JSON.stringify(win.__next_devtools__) : "absent";
    out.t0 = Date.now();
    const t0 = out.t0 as number;
    try {
      const r = await fetch("/api/pos/products?page=1&perPage=48");
      out.fetch = `status=${r.status} in ${Date.now() - t0}ms`;
    } catch (e) {
      out.fetch = `threw after ${Date.now() - t0}ms: ${String(e).slice(0, 120)}`;
    }
    try {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open("pos-offline");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const count = (store: string) =>
        new Promise<number>((resolve, reject) => {
          const tx = db.transaction(store, "readonly");
          const req = tx.objectStore(store).count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      out.offlineProductRows = await count("products");
      out.offlineCategoryRows = await count("categories");
      db.close();
    } catch (e) {
      out.idb = String(e);
    }
    return out;
  });
  console.log("offline probe:", JSON.stringify(probe, null, 2));

  const held = page.locator('button:has-text("Held Sales")');
  if ((await held.count()) > 0) {
    await held.click({ timeout: 3000 }).catch((e) => console.log("  held click failed:", String(e).slice(0, 120)));
    await page.waitForTimeout(800);
  }
  const clickTest = await page.evaluate(() => ({
    dialog: !!document.querySelector('[role="dialog"]'),
    status: document.querySelector('[data-status]')?.getAttribute("data-status") ?? null,
    indicatorText: document.querySelector('[role="status"]')?.textContent ?? null,
  }));
  console.log("click test:", JSON.stringify(clickTest));

  // give the catalog loader a long grace period
  await page.waitForTimeout(15000);
  const later = await page.evaluate(() => ({
    hasCola: document.body.innerText.includes("Cola 500ml"),
    skeleton: !!document.querySelector(".animate-pulse"),
    textLen: document.body.innerText.length,
  }));
  console.log("after 15s more:", JSON.stringify(later));
  console.log("network log:");
  netLog.forEach((l) => console.log(`  ${l}`));

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
