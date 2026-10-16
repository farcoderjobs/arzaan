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
    const u = r.url();
    if (u.includes('localhost:3000') && r.method() === 'POST') reqs.push({ method: r.method(), url: u, post: r.postData() });
  });
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERROR:', m.text()); });

  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[id="email"]', 'admin@pos.local');
  await page.fill('input[id="password"]', 'admin123');

  // Click the submit button
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  console.log('POST requests:', JSON.stringify(reqs, null, 2));
  const text = await page.textContent('body');
  const errorMatch = text?.match(/(Invalid credentials|Signed in|generalError|Error)/) ?? null;
  console.log('error-ish match:', errorMatch ? errorMatch[0] : 'none');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
