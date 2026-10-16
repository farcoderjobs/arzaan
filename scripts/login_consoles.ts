import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    console.log('[', m.type().toUpperCase(), ']', m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message));

  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[id="email"]', 'admin@pos.local');
  await page.fill('input[id="password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
