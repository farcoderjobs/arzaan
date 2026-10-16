import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  const reqErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('CONSOLE: ' + m.text()); });
  page.on('requestfailed', (r) => reqErrors.push('REQFAIL: ' + r.url() + ' ' + (r.failure()?.errorText ?? '')));

  // login as admin
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[id="email"]', 'admin@pos.local');
  await page.fill('input[id="password"]', 'admin123');
  await page.click('button[type="submit"]');

  // wait for navigation to any /dashboard or error
  try { await page.waitForURL('/dashboard', { timeout: 5000 }); } catch (e) { console.log('no /dashboard navigation'); }
  // capture final url and any text on page
  const finalUrl = page.url();
  const body = await page.textContent('body');
  console.log('FINAL URL:', finalUrl);
  console.log('CONSOLE ERRORS:', consoleErrors.join('\n'));
  console.log('REQ ERRORS:', reqErrors.join('\n'));
  console.log('BODY (first 600):', (body || '').slice(0, 600));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
