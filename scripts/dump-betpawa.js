// scripts/dump-betpawa.js
import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url = 'https://www.betpawa.com.gh/events?categoryId=2&marketId=Total%20Corners%20Over%2FUnder&day=today';
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('a[data-test-id="bp-event"]', { timeout: 5000 });
    const html = await page.locator('a[data-test-id="bp-event"]').first().innerHTML();
    console.log(html);
  } catch (e) {
    console.error('Error:', e.message);
  }
  
  await browser.close();
})();