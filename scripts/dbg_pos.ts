import { chromium } from "playwright";
(async () => {
  const browser = await chromium.launch({
    executablePath: "C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe",
    headless: true, args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.fill('input[id="email"]', "admin@pos.local");
  await page.fill('input[id="password"]', "admin123");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/dashboard", { timeout: 45000 });
  await page.goto("http://localhost:3000/pos", { waitUntil: "networkidle" });
  await page.waitForSelector("text=Cola 500ml", { timeout: 30000 });
  const text = (await page.textContent("body")) ?? "";
  const m = text.match(/.{0,60}\$\d.{0,60}/);
  console.log("MATCH:", m ? m[0] : "none");
  await browser.close();
})();
