import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`PASS: ${name}`); } else { failed++; console.log(`FAIL: ${name} ${extra}`); }
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
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    // Wait for React hydration: a click before hydration falls through to a native form GET
    await page.waitForFunction(
      `(() => { const b = document.querySelector('button[type="submit"]'); return b && Object.keys(b).some((k) => k.startsWith('__reactProps$')); })()`
    );
    await page.waitForTimeout(300);
    check('login page loads', (await page.title()).includes('POS'));

    await page.fill('input[id="email"]', 'admin@pos.local');
    await page.fill('input[id="password"]', 'admin123');
    await page.click('button[type="submit"]');

    // wait up to 30s for redirect to /dashboard (dev-mode first compile can be slow)
    let toDashboard = false;
    try { await page.waitForURL('**/dashboard', { timeout: 30000 }); toDashboard = true; } catch (e) {}

    const cookies = await page.context().cookies();
    const tok = cookies.find((c) => c.name === 'pos_access_token');
    const refresh = cookies.find((c) => c.name === 'pos_refresh_token');
    check('redirects to /dashboard', toDashboard, page.url());
    check('pos_access_token cookie set', !!tok, tok ? tok.value.slice(0, 12) : 'none');
    check('pos_refresh_token cookie set', !!refresh);

    if (errors.length) check('no page errors after login', false, errors.join(' | '));
    else check('no page errors after login', true);

    // if logged in, dashboard has sidebar
    if (toDashboard) {
      await page.waitForSelector('text=Sales', { timeout: 8000 }).catch(() => {});
      check('dashboard sidebar has Sales nav', await page.textContent('text=Sales') !== null);
    }
  } catch (e) {
    failed++; console.log('FAIL: setup', e);
  } finally {
    if (browser) await browser.close();
  }
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
