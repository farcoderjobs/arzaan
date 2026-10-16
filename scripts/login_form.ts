import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });

  // Get the form element and its attributes
  const formInfo = await page.evaluate(() => {
    const form = document.querySelector('form');
    if (!form) return 'no form';
    const els = Array.from(form.elements).map((e) => {
      const el = e as HTMLInputElement & { onSubmit?: unknown };
      return {
        tag: el.tagName,
        type: el.type,
        id: el.id,
        name: el.name,
        onsubmit: typeof el.onSubmit === 'function' ? 'bound' : el.onSubmit,
      };
    });
    return {
      action: form.getAttribute('action'),
      method: form.method,
      elements: els,
    };
  });
  console.log('FORM:', JSON.stringify(formInfo, null, 2));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
