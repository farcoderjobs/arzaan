import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[id="email"]', 'admin@pos.local');
  await page.fill('input[id="password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
  const html = await page.innerHTML('body');
  // look for generalError or error text
  const m = html.match(/generalError[^>]*>([\s\S]*?)<\/div>/);
  console.log('GENERAL ERROR element:', m ? m[1].slice(0, 200) : 'none');
  // also check for 'Signed in' or 'Invalid'
  const signed = html.match(/Signed in[^<]*/);
  const invalid = html.match(/Invalid[^<]*/);
  console.log('Signed in:', signed ? signed[0] : 'none');
  console.log('Invalid:', invalid ? invalid[0] : 'none');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
