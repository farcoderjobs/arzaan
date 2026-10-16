import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const reqs: Array<{ method: string; url: string; post: string | null }> = [];
  page.on('request', (r) => {
    if (r.method() === 'POST') reqs.push({ method: r.method(), url: r.url(), post: r.postData() });
  });
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERROR:', m.text()); });

  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  // Fill fields
  await page.fill('input[id="email"]', 'admin@pos.local');
  await page.fill('input[id="password"]', 'admin123');

  // Try triggering submit via JS
  const result = await page.evaluate(async () => {
    const form = document.querySelector('form');
    if (!form) return 'no form';
    // try calling the login action directly if exposed
    const w = window as unknown as { __ACTIONS?: { login?: unknown }; login?: unknown };
    const loginFn = w.__ACTIONS?.login || w.login;
    const out = {
      typeofLogin: typeof loginFn,
      hasFormOnSubmit: typeof form.onSubmit === 'function',
      canSubmit: typeof form.requestSubmit === 'function',
    };
    // dispatch submit
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return out;
  });
  console.log('EVAL:', JSON.stringify(result, null, 2));
  await page.waitForTimeout(3000);
  console.log('POST requests:', JSON.stringify(reqs, null, 2));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
