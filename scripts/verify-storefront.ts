/**
 * Browser verification for the public storefront + admin add-product flow.
 * Requires the seeded admin (npx tsx src/scripts/seed-demo.ts →
 * admin@pos.local / admin123)
 * and a running app:
 *   npx tsx scripts/verify-storefront.ts [baseUrl]
 * It creates a temporary product through /store-products/new, checks that it
 * appears on /, then deletes it again.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";
const results: string[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  const line = `${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`;
  results.push(line);
  console.log(line);
};

/** Wait until the admin table shows real rows (not the 5-row loading skeleton). */
async function waitRows(page: import("playwright").Page, min = 1, ms = 20000) {
  return wait(
    page,
    () => {
      const rows = document.querySelectorAll("table tbody tr");
      return rows.length >= min && !document.querySelector("table tbody .animate-pulse");
    },
    ms
  );
}

/** Light background check — Chrome reports Tailwind v4 colors as rgb() or lab(). */
function isLight(color: string): boolean {
  if (color.startsWith("rgb")) {
    const [r, g, b] = color.match(/\d+/g)!.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 200;
  }
  if (color.startsWith("lab")) return Number(color.match(/lab\(([-\d.]+)/)?.[1] ?? 0) > 90;
  return false;
}

function isDarkText(color: string): boolean {
  if (color.startsWith("rgb")) {
    const [r, g, b] = color.match(/\d+/g)!.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140;
  }
  if (color.startsWith("lab")) return Number(color.match(/lab\(([-\d.]+)/)?.[1] ?? 100) < 50;
  return false;
}

/** Wait until `predicate` is true (client data has loaded), max `ms`. */
async function wait(page: import("playwright").Page, predicate: () => boolean, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (await page.evaluate(predicate)) return true;
    } catch {
      /* navigation in flight */
    }
    await page.waitForTimeout(250);
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  // ---------- 1. Public storefront ----------
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await wait(page, () => document.querySelectorAll("article").length > 0);
  await page.waitForTimeout(800);

  const store = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("article"));
    const doc = document.documentElement;
    const grid = cards[0]?.parentElement;
    const card0 = cards[0];
    const btn = card0?.querySelector("button");
    const root = document.querySelector(".store-root") as Element;
    const bodyStyle = getComputedStyle(document.body);
    return {
      cardCount: cards.length,
      rootBg: getComputedStyle(root).backgroundColor,
      rootColor: getComputedStyle(root).color,
      bodyBg: bodyStyle.backgroundColor,
      cardBg: card0 ? getComputedStyle(card0).backgroundColor : null,
      cardBorder: card0 ? getComputedStyle(card0).borderColor : null,
      cardRadius: card0 ? getComputedStyle(card0).borderRadius : null,
      btnBg: btn ? getComputedStyle(btn).backgroundColor : null,
      gridCols: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
      horizontalOverflow: doc.scrollWidth > doc.clientWidth,
      scrollW: doc.scrollWidth,
      clientW: doc.clientWidth,
      heading: document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      categoryChips: document.querySelectorAll("main ~ *, section button").length,
      heroBg: getComputedStyle(document.querySelector("section") as Element).backgroundImage.slice(0, 60),
    };
  });
  check("storefront renders product cards", store.cardCount === 12, `cards=${store.cardCount}`);
  check("storefront is light themed", isLight(store.rootBg) && isDarkText(store.rootColor), `${store.rootBg} / ${store.rootColor}`);
  check("cards are white", store.cardBg === "rgb(255, 255, 255)", String(store.cardBg));
  check("grid has 3 columns at 1440px", store.gridCols === 3, `cols=${store.gridCols}`);
  check("no horizontal overflow", !store.horizontalOverflow, `${store.scrollW}/${store.clientW}`);
  check("hero headline present", store.heading.includes("delivered to your door"), store.heading);
  await page.screenshot({ path: "/tmp/store-final.png", fullPage: true });

  // ---------- 2. Cart interaction ----------
  await page.locator("article button", { hasText: /Add to cart/ }).first().click();
  await page.waitForTimeout(500);
  const badge = (await page.locator("#cart-badge").textContent())?.trim();
  check("add to cart updates badge", badge === "1", `badge=${badge}`);
  await page.getByRole("button", { name: "Open cart" }).click();
  await page.waitForTimeout(500);
  const drawerTitle = (await page.locator("aside h2").textContent())?.trim();
  check("cart drawer opens", drawerTitle === "Your cart", String(drawerTitle));
  const lineCount = await page.locator("aside li").count();
  check("cart line rendered", lineCount === 1, `lines=${lineCount}`);
  await page.screenshot({ path: "/tmp/store-cart.png" });
  await page.getByRole("button", { name: "Close cart" }).click();
  await page.waitForTimeout(300);

  // ---------- 3. Login ----------
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  const hasLoginForm = await wait(page, () => Boolean(document.querySelector("#email")), 30000);
  if (!hasLoginForm) {
    console.log("login form missing — url:", page.url());
    console.log("body:", await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 300)));
  }
  // The page is client-rendered: retry until React has hydrated (a fill that
  // lands before hydration gets wiped by the first controlled re-render).
  let loggedIn = false;
  for (let attempt = 1; attempt <= 5 && !loggedIn && hasLoginForm; attempt++) {
    await page.waitForTimeout(1000);
    try {
      await page.fill("#email", "admin@pos.local", { timeout: 8000 });
      await page.fill("#password", "admin123", { timeout: 8000 });
    } catch (err) {
      console.log("fill failed — url:", page.url());
      console.log("body:", await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 200)).catch(() => "<evaluate failed>"));
      console.log("err:", String(err).slice(0, 200));
      continue;
    }
    await page.waitForTimeout(300);
    const kept = (await page.inputValue("#email")) === "admin@pos.local";
    if (!kept) continue;
    await page.click("button[type=submit]");
    await page.waitForTimeout(3000);
    loggedIn = page.url().includes("/dashboard");
  }
  // The redirect can land just after the last attempt — give it a moment.
  if (!loggedIn) {
    await page.waitForURL("**/dashboard", { timeout: 10000 }).catch(() => undefined);
    loggedIn = page.url().includes("/dashboard");
  }
  check("admin login", loggedIn, page.url());
  if (!loggedIn) {
    console.log("login body:", await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 300)));
  }

  // ---------- 4. Store products list ----------
  await page.goto(`${BASE}/store-products`, { waitUntil: "domcontentloaded" });
  await waitRows(page);
  await page.waitForTimeout(400);
  const rows = await page.locator("table tbody tr").count();
  check("store-products list shows seeded rows", rows === 12, `rows=${rows}`);
  const sidebarLink = await page.locator('a[href="/store-products"]').count();
  check("sidebar link to store products visible", sidebarLink > 0, `links=${sidebarLink}`);
  await page.screenshot({ path: "/tmp/store-products-list.png", fullPage: true });

  // ---------- 5. Dedicated add page ----------
  await page.getByRole("link", { name: "Add product" }).first().click();
  await page.waitForURL("**/store-products/new", { timeout: 15000 });
  const unique = `QA Test Product ${Date.now()}`;
  await page.fill('input[placeholder="e.g. Premium Green Tea 250g"]', unique);
  await page.fill('textarea[placeholder="Short, appealing description…"]', "Created by browser verification");
  const numbers = page.locator('input[type="number"]');
  await numbers.nth(0).fill("250");
  await numbers.nth(1).fill("300");
  await numbers.nth(2).fill("5");
  await page.waitForTimeout(400);
  const previewName = (await page.locator("h3").last().textContent())?.trim();
  check("live preview shows product name", previewName === unique, String(previewName));
  await page.screenshot({ path: "/tmp/store-products-new.png", fullPage: true });
  await page.getByRole("button", { name: "Add product" }).click();
  await page.waitForURL("**/store-products", { timeout: 20000 }).catch(() => undefined);
  check("form navigates back to list", page.url().endsWith("/store-products"), page.url());
  await waitRows(page);
  await page.waitForTimeout(400);
  const firstRow = (await page.locator("table tbody tr").first().textContent()) ?? "";
  check("new product appears in list", firstRow.includes(unique), firstRow.slice(0, 80));

  // ---------- 6. Public storefront picked it up ----------
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await wait(page, () => document.querySelectorAll("article").length > 0);
  await page.waitForTimeout(600);
  const cardsAfter = await page.locator("article").count();
  check("storefront shows the new product", cardsAfter === 13, `cards=${cardsAfter}`);

  // ---------- 7. Cleanup: delete the QA product ----------
  await page.goto(`${BASE}/store-products`, { waitUntil: "domcontentloaded" });
  await waitRows(page);
  await page.waitForTimeout(400);
  const row = page.getByRole("row").filter({ hasText: unique });
  await row.getByRole("button").last().click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Remove" }).click();
  await waitRows(page, 12, 20000);
  await page.waitForTimeout(500);
  const rowsAfter = await page.locator("table tbody tr").count();
  check("QA product deleted", rowsAfter === 12, `rows=${rowsAfter}`);

  // ---------- 8. Admin sidebar / dashboard sanity ----------
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: "/tmp/dashboard.png", fullPage: true });

  check("no console/page errors", errors.length === 0, errors.slice(0, 5).join(" | "));

  await browser.close();
  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("verify crashed:", err);
  process.exit(1);
});
