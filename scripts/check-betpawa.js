// scripts/check-betpawa.js
import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const tests = [
    'Total%20Corners%20Over%2FUnder',
    'Total%20Bookings%20Over%2FUnder',
    'Total%20Shots%20Over%2FUnder',
    'Shots%20on%20Target%20Over%2FUnder'
  ];
  
  for (const m of tests) {
    const url = 'https://www.betpawa.com.gh/events?categoryId=2&marketId=' + m + '&day=today';
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('a[data-test-id="bp-event"]', { timeout: 5000 });
      const count = await page.locator('a[data-test-id="bp-event"]').count();
      console.log(m, '=> FOUND', count, 'matches');
    } catch (e) {
      console.log(m, '=> NOT FOUND (empty or timed out)');
    }
  }
  await browser.close();
})();