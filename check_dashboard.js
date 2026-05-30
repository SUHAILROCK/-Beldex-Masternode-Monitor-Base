const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--start-maximized'],
    defaultViewport: null
  });

  const page = await browser.newPage();
  const logs = [];
  const errors = [];
  const networkErrors = [];

  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();
    logs.push({ type, text });
  });

  page.on('pageerror', err => {
    errors.push({ type: 'pageerror', text: err.message });
  });

  page.on('requestfailed', req => {
    networkErrors.push({ url: req.url(), reason: req.failure()?.errorText });
  });

  page.on('response', async res => {
    if (res.status() >= 400) {
      networkErrors.push({ url: res.url(), status: res.status() });
    }
  });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 15000 });
  console.log('\n=== CURRENT URL ===');
  console.log(page.url());

  if (page.url().includes('/login')) {
    console.log('[Logging in with default password...]');
    await page.waitForSelector('input[type=password]', { timeout: 5000 }).catch(() => {});
    await page.type('input[type=password]', 'updown890').catch(e => console.log('password input error:', e.message));
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForNavigation({ timeout: 8000 }).catch(() => {});
    console.log('After login URL:', page.url());
  }

  await new Promise(r => setTimeout(r, 4000));

  console.log('\n=== ALL CONSOLE LOGS ===');
  logs.forEach(l => console.log(`[${l.type.toUpperCase()}] ${l.text}`));

  console.log('\n=== PAGE ERRORS ===');
  if (errors.length === 0) console.log('None');
  errors.forEach(e => console.log(`[${e.type.toUpperCase()}] ${e.text}`));

  console.log('\n=== NETWORK FAILURES (4xx/5xx/failed) ===');
  if (networkErrors.length === 0) console.log('None');
  networkErrors.forEach(e => console.log(`${e.status || 'FAIL'} ${e.url} ${e.reason || ''}`));

  // Get page title and visible content summary
  const title = await page.title();
  console.log('\n=== PAGE TITLE ===', title);

  console.log('\n[Browser left open — inspect manually]');
})();
