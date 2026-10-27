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
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Turns BetPawa's card text into an epoch-ms kickoff.
 *
 * The listing renders either an ISO `datetime` attribute or human text such as
 * "27 Oct 20:00", "27/10 20:00" or just "20:00". A bare time is anchored to the
 * "today / tomorrow" tab that produced the row, and Ghana is UTC+0 so the wall clock
 * is the UTC clock. Returns null when nothing parseable is found.
 */
function parseKickoff(raw, dayOffset = 0, nowMs = Date.now()) {
  const text = String(raw ?? '');
  if (!text) return null;

  const iso = text.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const parsed = Date.parse(iso[0]);
    if (Number.isFinite(parsed)) return parsed;
  }

  const time = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!time) return null;
  const hours = Number(time[1]);
  const minutes = Number(time[2]);

  const dayMonth = text.match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i);
  const daySlash = text.match(/\b(\d{1,2})\/(\d{1,2})\b/);

  const base = new Date(nowMs + dayOffset * 24 * 3600_000);
  let year = base.getUTCFullYear();
  let month = base.getUTCMonth();
  let day = base.getUTCDate();

  if (dayMonth) {
    day = Number(dayMonth[1]);
    month = MONTHS[dayMonth[2].toLowerCase()];
  } else if (daySlash) {
    day = Number(daySlash[1]);
    month = Number(daySlash[2]) - 1;
  }

  let ts = Date.UTC(year, month, day, hours, minutes);

  // Cards rendered just after midnight can describe yesterday's slot; roll forward instead.
  if (ts < nowMs - 6 * 3600_000) ts += 24 * 3600_000;
  return ts;
}
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

          // Start time lives inside the card, usually as a <time> element but sometimes as
          // plain text ("27 Oct 20:00"). Keep the raw string; the day context is known in Node.
          const timeEl = link.querySelector('time');
          const kickoffText = [
            timeEl?.getAttribute('datetime'),
            timeEl?.textContent,
            link.querySelector('[data-test-id*="start" i]')?.textContent,
            link.querySelector('[class*="startTime" i], [class*="StartTime" i]')?.textContent,
            link.querySelector('[class*="startDate" i], [class*="date" i]')?.textContent,
            link.innerText,
          ]
            .map((value) => (value ?? '').trim())
            .filter(Boolean)
            .join(' | ');

          const eventData = { eventId, home, away, kickoffText, odds: {} };

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
      const dayOffset = Math.max(0, DAYS.indexOf(day));
      for (const ev of extracted) {
        const { kickoffText, ...rest } = ev;
        const kickoff = parseKickoff(kickoffText, dayOffset) ?? undefined;

        if (!allEvents.has(ev.eventId)) {
          allEvents.set(ev.eventId, { ...rest, kickoff, odds: {} });
        }
        const existing = allEvents.get(ev.eventId);
        if (!existing.kickoff && kickoff) existing.kickoff = kickoff;

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

  const missing = finalEvents.filter((e) => !e.kickoff).length;
  const kickoffs = finalEvents.length - missing;
  console.log(`   Kickoffs resolved: ${kickoffs}/${finalEvents.length}`);
  if (missing > 0) {
    console.log(
      `⚠️ ${missing} event(s) had no readable start time; find-arbs.js cannot time-match those.`,
    );
  }

  await browser.close();
}

fetchBetPawa().catch(console.error);