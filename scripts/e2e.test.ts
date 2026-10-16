import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name} ${extra}`); }
}

(async () => {
  let browser = null;
  try {
    browser = await chromium.launch({
      executablePath: 'C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe',
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();

    // 1. Login page
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    check('login page loads', (await page.title()).includes('POS'));

    // 2. Login
    await page.fill('input[id="email"]', 'admin@pos.local');
    await page.fill('input[id="password"]', 'admin123');
    const submit = page.locator('button[type="submit"]');
    await submit.click();
    let dashboard = false;
    try { await page.waitForURL('/dashboard', { timeout: 8000 }); dashboard = true; } catch (e) {}
    check('login redirects to /dashboard', dashboard);

    // confirm session cookie set
    const cookies = await page.context().cookies();
    const hasAccess = cookies.some((c) => c.name === 'pos_access_token');
    check('session cookie pos_access_token set', hasAccess);

    // dashboard should have sidebar with Sales & Returns nav
    await page.waitForSelector('text=Sales', { timeout: 10000 }).catch(() => {});
    const sidebarText = await page.textContent('text=Sales');
    check('sidebar shows Sales nav', sidebarText !== null);

    // 3. Open POS
    await page.goto(`${BASE}/pos`, { waitUntil: 'domcontentloaded' });
    check('pos page loads', ((await page.textContent('body')) ?? '').includes('Cola'));

    // 4. Search product (barcode)
    await page.fill('input[placeholder*="Search"]', '8901234500011');
    await page.waitForTimeout(1500);
    const prodLabel = await page.textContent('text=Cola 500ml');
    check('product found by barcode search', prodLabel !== null);

    await browser.close();
  } catch (e) {
    failed++; console.log('FAIL: setup', e);
  } finally {
    if (browser) await browser.close();
  }
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
