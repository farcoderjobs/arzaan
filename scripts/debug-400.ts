/**
 * Reproduces the reported `POST /api/purchases 400` and `POST /api/sales 400`
 * through the real UI flows and prints the response bodies.
 *
 * Run: npx tsx scripts/debug-400.ts  (dev server on :3001)
 */
import { chromium } from "playwright";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const CHROME =
  "C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe";

const captured: string[] = [];
function note(line: string) {
  captured.push(line);
  console.log(line);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__name = (f: unknown) => f;
  });
  page.on("response", async (r) => {
    const u = r.url();
    if (
      r.request().method() === "POST" &&
      (u.includes("/api/purchases") || u.includes("/api/sales") || u.includes("/api/cash-register"))
    ) {
      let body = "";
      try {
        body = (await r.text()).slice(0, 400);
      } catch {
        /* ignore */
      }
      note(`  ${r.request().method()} ${u.replace(BASE, "")} -> ${r.status()} ${body}`);
    }
  });

  try {
    // ---------- login ----------
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForFunction(
      `(() => { const b = document.querySelector('button[type="submit"]'); return b && Object.keys(b).some((k) => k.startsWith('__reactProps$')); })()`
    );
    await page.fill('input[id="email"]', "admin@pos.local");
    await page.fill('input[id="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard", { timeout: 60_000 });
    console.log("logged in");

    // ---------- 1. Purchase creation via UI ----------
    await page.goto(`${BASE}/purchases`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.getByRole("button", { name: /New Purchase/ }).click();
    const dlg = page.getByRole("dialog");
    await dlg.waitFor({ timeout: 15_000 });
    // supplier select (0) + first item product select (1)
    await dlg.evaluate((d) => {
      const selects = d.querySelectorAll("select");
      const supplier = selects[0] as HTMLSelectElement;
      const product = selects[1] as HTMLSelectElement;
      const firstVal = (s: HTMLSelectElement) =>
        Array.from(s.options).find((o) => o.value)?.value ?? "";
      supplier.value = firstVal(supplier);
      supplier.dispatchEvent(new Event("change", { bubbles: true }));
      product.value = firstVal(product);
      product.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await dlg.locator('input[placeholder="Price"]').first().fill("10");
    console.log("purchase form filled");
    await dlg.getByRole("button", { name: "Create Purchase" }).click();
    await page.waitForTimeout(4000);
    const dialogClosed = !(await dlg.isVisible().catch(() => false));
    const purchaseToast = await page
      .textContent("body")
      .then((b) =>
        (b ?? "")
          .split("\n")
          .filter((l) => /Purchase created|Failed to create|not found|Validation/i.test(l))
          .slice(0, 3)
      );
    console.log(`purchase dialog closed=${dialogClosed} toast-ish lines=${JSON.stringify(purchaseToast)}`);

    // ---------- 2a. POS sale without discount ----------
    await page.goto(`${BASE}/pos`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.locator("button.h-28:not([disabled])").first().waitFor({ timeout: 30_000 });
    await page.locator("button.h-28:not([disabled])").first().click();
    await page.getByRole("button", { name: /F4/ }).click();
    await page.getByRole("dialog").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: /F9/ }).click();
    const sale1Modal = await page
      .getByText("Sale Completed")
      .first()
      .waitFor({ timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    console.log(`sale #1 (no discount) completed=${sale1Modal}`);
    if (sale1Modal) await page.getByRole("button", { name: "New Sale" }).click();

    // ---------- 2b. POS sale with 20% discount (over the default 10% cap) ----------
    await page.locator("button.h-28:not([disabled])").first().waitFor({ timeout: 30_000 });
    await page.locator("button.h-28:not([disabled])").first().click();
    await page.locator("input.w-20").first().fill("20");
    await page
      .locator("select")
      .filter({ has: page.locator('option[value="percent"]') })
      .selectOption("percent");
    await page.getByRole("button", { name: /F4/ }).click();
    await page.getByRole("dialog").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: /F9/ }).click();
    await page.waitForTimeout(4000);
    const sale2Modal = await page
      .getByText("Sale Completed")
      .first()
      .isVisible()
      .catch(() => false);
    const bodyText = (await page.textContent("body")) ?? "";
    const toastLine = bodyText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /Discount|exceeds|Sale failed|register|stock/i.test(l))
      .slice(0, 5);
    console.log(`sale #2 (20% discount) completed=${sale2Modal}`);
    console.log(`visible messages: ${JSON.stringify(toastLine)}`);

    // ---------- 2c. POS sale with 10% discount (at the cap) ----------
    if (sale2Modal) await page.getByRole("button", { name: "New Sale" }).click();
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await page.locator("button.h-28:not([disabled])").first().click();
    await page.locator("input.w-20").first().fill("10");
    await page
      .locator("select")
      .filter({ has: page.locator('option[value="percent"]') })
      .selectOption("percent");
    await page.getByRole("button", { name: /F4/ }).click();
    await page.getByRole("dialog").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: /F9/ }).click();
    const sale3Modal = await page
      .getByText("Sale Completed")
      .first()
      .waitFor({ timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    console.log(`sale #3 (10% discount) completed=${sale3Modal}`);
  } catch (e) {
    console.log("script error:", e);
  } finally {
    await browser.close();
    console.log("\n=== captured POSTs ===");
    captured.forEach((c) => console.log(c));
  }
})();
