// scripts/fetch-betpawa.js
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.resolve(__dirname, '..', 'data');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE_URL = 'https://www.betpawa.com.gh/events?categoryId=2';
const DAYS = ['today', 'tomorrow'];
const MARKETS = [
  { param: 'marketId=1X2', type: '1X2' },
  { param: 'marketId=Total%20Goals%20Over%2FUnder', type: 'OU' },
  { param: 'marketId=Double%20Chance', type: 'DC' },
  { param: 'marketId=Both%20Teams%20to%20Score%20%28GG%2FNG%29', type: 'BTTS' }
];

async function fetchBetPawa() {
  console.log('🚀 Launching headless browser for BetPawa...');
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const allEvents = new Map();

  for (const day of DAYS) {
    for (const market of MARKETS) {
      const targetUrl = `${BASE_URL}&${market.param}&day=${day}`;
      console.log(`\n🌐 Navigating to [${market.type} - ${day}]: ${targetUrl}`);
      
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('a[data-test-id="bp-event"]', { timeout: 10000 });
      } catch (e) {
        console.log(`⚠️ No matches found for [${market.type} - ${day}] or page timed out.`);
        continue;
      }

      // --- INFINITE SCROLL LOGIC ---
      console.log('⏳ Scrolling to load all matches...');
      let previousCount = 0;
      let scrollAttempts = 0;
      const MAX_SCROLL_ATTEMPTS = 50;

      while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
        const currentCount = await page.locator('a[data-test-id="bp-event"]').count();
        
        if (currentCount === previousCount) {
          break;
        }
        
        previousCount = currentCount;
        
        // Scroll and wait for the network request to complete
        try {
          await Promise.all([
            page.waitForResponse(response => 
              response.url().includes('events') && 
              response.request().resourceType() === 'fetch' &&
              response.status() === 200
            , { timeout: 3000 }).catch(() => {}), // Ignore timeout if no more matches are loading
            page.evaluate(() => {
              const container = document.getElementById('scrollable-wrapper');
              if (container) container.scrollTop = container.scrollHeight;
            })
          ]);
        } catch (e) {
          // No network request happened, so we're at the bottom
        }
        
        await sleep(500); // Give React time to paint the new elements
        scrollAttempts++;
      }
      console.log(`✅ Finished scrolling (${scrollAttempts} scrolls). Extracted ${previousCount} elements.`);

      // --- EXTRACTION LOGIC ---
      const extracted = await page.evaluate((marketType) => {
        const results = [];
        const matchLinks = document.querySelectorAll('a[data-test-id="bp-event"]');

        matchLinks.forEach((link) => {
          const href = link.getAttribute('href');
          const eventIdMatch = href.match(/\/event\/(\d+)/);
          const eventId = eventIdMatch ? `betpawa:${eventIdMatch[1]}` : null;
          if (!eventId) return;

          const teamSpans = link.querySelectorAll('.ScoreBoard_participantName__y6Dwg span');
          if (teamSpans.length < 2) return;
          const home = teamSpans[0].innerText.trim();
          const away = teamSpans[1].innerText.trim();

          const eventData = { eventId, home, away, odds: {} };

          const buttons = link.querySelectorAll('button[data-test-id^="odd-"]');
          
          buttons.forEach((btn) => {
            const label = btn.querySelector('span')?.innerText.trim();
            const oddsSpan = btn.querySelector('span[class*="oddsValue"]');
            if (!oddsSpan) return;
            
            const price = parseFloat(oddsSpan.innerText);
            if (isNaN(price)) return;

            if (marketType === '1X2') {
              if (label === '1') eventData.odds.home = price;
              if (label === 'X') eventData.odds.draw = price;
              if (label === '2') eventData.odds.away = price;
            } else if (marketType === 'DC') {
              if (label === '1X') eventData.odds.dc1x = price;
              if (label === '12') eventData.odds.dc12 = price;
              if (label === 'X2') eventData.odds.dcx2 = price;
            } else if (marketType === 'BTTS') {
              if (label === 'Yes') eventData.odds.bttsYes = price;
              if (label === 'No') eventData.odds.bttsNo = price;
            } else if (marketType === 'OU') {
              eventData.odds[label] = price;
            }
          });

          if (Object.keys(eventData.odds).length > 0) {
            results.push(eventData);
          }
        });

        return results;
      }, market.type);

      // --- MERGE LOGIC ---
      for (const ev of extracted) {
        if (!allEvents.has(ev.eventId)) {
          allEvents.set(ev.eventId, { ...ev, odds: {} });
        }
        const existing = allEvents.get(ev.eventId);
        
        for (const [key, val] of Object.entries(ev.odds)) {
          existing.odds[key] = val;
        }
      }
      console.log(`✅ Extracted ${extracted.length} matches with [${market.type} - ${day}] odds. (Total unique matches: ${allEvents.size})`);
    }
  }

  const finalEvents = Array.from(allEvents.values()).filter(e => 
    Object.keys(e.odds).length > 0
  );

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'betpawa.json');
  fs.writeFileSync(outFile, JSON.stringify({ events: finalEvents }, null, 2));
  console.log(`\n💾 Saved ${finalEvents.length} total matches to ${outFile}`);

  await browser.close();
}

fetchBetPawa().catch(console.error);