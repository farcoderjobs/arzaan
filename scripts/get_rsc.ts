import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  // collect all network responses
  const rscs: Array<{ url: string; len: number; head: string }> = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('_rsc') || u.includes('rsc') || u.includes('next-action')) {
      try {
        const t = await r.text();
        rscs.push({ url: u, len: t.length, head: t.slice(0, 120) });
      } catch (e) {}
    }
  });
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  // submit
  await page.fill('input[id="email"]', 'admin@pos.local');
  await page.fill('input[id="password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
  console.log('RSC responses:');
  for (const r of rscs) console.log(r.url, 'len=', r.len, 'head=', r.head);
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
