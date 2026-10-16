import { chromium } from "playwright";
(async () => {
  const browser = await chromium.launch({
    executablePath: "C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  page.on("request", (r) => { if (r.method() !== "GET") console.log("REQ", r.method(), r.url().slice(0, 120)); });
  page.on("response", (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); });
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 300)));
  page.on("console", (m) => console.log("CONSOLE[" + m.type() + "]:", m.text().slice(0, 200)));
  await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.fill('input[id="email"]', "admin@pos.local");
  await page.fill('input[id="password"]', "admin123");
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(6000);
  console.log("URL after submit:", page.url());
  const body = (await page.textContent("body")) ?? "";
  console.log("BODY SNIPPET:", body.replace(/\s+/g, " ").slice(0, 400));
  await browser.close();
})();
