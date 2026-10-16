import { chromium } from 'playwright';
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe', headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[id="email"]', 'admin@pos.local');
  await page.fill('input[id="password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL('/dashboard', { timeout: 10000 });
  const cookies = await page.context().cookies();
  await browser.close();
  for (const c of cookies) console.log(c.name + '=' + c.value);
})().catch(e => { console.error(e); process.exit(1); });
