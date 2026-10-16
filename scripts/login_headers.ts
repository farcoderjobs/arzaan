import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/login')) {
      const headers = r.headers();
      console.log('POST /login headers:');
      for (const [k, v] of Object.entries(headers)) console.log(' ', k, '=', v);
    }
  });
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERROR:', m.text()); });

  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[id="email"]', 'admin@pos.local');
  await page.fill('input[id="password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
