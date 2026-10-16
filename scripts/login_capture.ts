import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const allRequests: Array<{ method: string; url: string; postData: string | null }> = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('login') || u.includes('action') || u.includes('dashboard') || u.includes('account') || u.includes('refresh')) {
      allRequests.push({ method: r.method(), url: u, postData: r.postData() });
    }
  });

  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[id="email"]', 'admin@pos.local');
  await page.fill('input[id="password"]', 'admin123');
  await page.click('button[type="submit"]');

  await page.waitForTimeout(3000);
  console.log('REQUESTS AFTER CLICK:');
  for (const req of allRequests) {
    console.log(req.method, req.url, '| body:', req.postData ? req.postData.slice(0, 300) : '(none)');
  }
  const body = await page.textContent('body');
  console.log('BODY snippet:', (body || '').slice(0, 400));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
