import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  let loginResp = null;
  page.on('response', (r) => {
    if (r.url().includes('/login') && r.request().method() === 'POST') {
      loginResp = r;
      r.text().then((t) => console.log('POST /login RESPONSE BODY:', t.slice(0, 500))).catch(() => {});
    }
  });
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERROR:', m.text()); });

  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[id="email"]', 'admin@pos.local');
  await page.fill('input[id="password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  const url = page.url();
  console.log('FINAL URL:', url);
  const text = await page.textContent('body');
  const err = text?.match(/generalError[^>]*>([\s\S]*?)<\/div>/) ?? null;
  console.log('generalError:', err ? err[1].slice(0, 200) : 'none');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
