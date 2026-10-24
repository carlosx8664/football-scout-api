// scripts/test-scroll.js
import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.goto('https://www.betpawa.com.gh/events?categoryId=2&marketId=1X2&day=today');
  await page.waitForTimeout(3000);
  
  const before = await page.locator('a[data-test-id="bp-event"]').count();
  console.log('Matches before scroll:', before);
  
  // Try scrolling the window
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(4000);
  const afterWindowScroll = await page.locator('a[data-test-id="bp-event"]').count();
  console.log('Matches after window.scrollTo:', afterWindowScroll);
  
  // Try scrolling the #scrollable-wrapper container
  await page.evaluate(() => {
    const el = document.getElementById('scrollable-wrapper');
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(4000);
  const afterContainerScroll = await page.locator('a[data-test-id="bp-event"]').count();
  console.log('Matches after container.scrollTop:', afterContainerScroll);
  
  // Try dispatching a wheel event on the body
  await page.mouse.wheel(0, 10000);
  await page.waitForTimeout(4000);
  const afterWheel = await page.locator('a[data-test-id="bp-event"]').count();
  console.log('Matches after mouse.wheel:', afterWheel);
  
  // Try clicking at the very bottom of the page (may trigger next page)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  const buttons = await page.locator('button').all();
  console.log('Total buttons on page:', buttons.length);

  await browser.close();
})();