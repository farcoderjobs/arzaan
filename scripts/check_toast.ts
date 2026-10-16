/** Verifies the POS surfaces the server's discount-cap 400 message as a toast. */
import { chromium } from "playwright";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const CHROME =
  "C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe";

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

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForFunction(
    `(() => { const b = document.querySelector('button[type="submit"]'); return b && Object.keys(b).some((k) => k.startsWith('__reactProps$')); })()`
  );
  await page.fill('input[id="email"]', "admin@pos.local");
  await page.fill('input[id="password"]', "admin123");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 60_000 });

  await page.goto(`${BASE}/pos`, { waitUntil: "networkidle", timeout: 90_000 });
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
  await page.waitForTimeout(3000);

  const body = (await page.textContent("body")) ?? "";
  const occurrences = body.match(/Discount 20% exceeds the maximum allowed/g) ?? [];
  console.log("toast occurrences:", occurrences.length);
  const ok = occurrences.length >= 1;
  console.log(
    ok && occurrences.length === 1
      ? "PASS: discount-cap message visible exactly once"
      : ok
        ? `WARN: message visible ${occurrences.length} times (expected 1)`
        : "FAIL: message not visible"
  );
  await browser.close();
  process.exit(ok && occurrences.length === 1 ? 0 : 1);
})();
