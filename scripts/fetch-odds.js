// scripts/fetch-odds.js
// Downloads the next 48h of football fixtures + odds from SportyBet and MSport
// into data/sportybet.json and data/msport.json.
//
// SportyBet now asks for several markets (1X2, Double Chance, DNB, Over/Under, GG/NG).
// If SportyBet ignores the combined list, the script automatically falls back to one
// request per market and merges the results by eventId.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 2-day window
const LOOKAHEAD_MS = 48 * 60 * 60 * 1000;
const NOW = Date.now();
const CUTOFF = NOW + LOOKAHEAD_MS;

// Keep matches that haven't started yet, up to 2 days from now
function withinWindow(ts) {
  if (!ts) return false;
  return ts >= NOW - 60 * 60 * 1000 && ts <= CUTOFF;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// SportyBet
// ============================================================================
// 1 = 1X2, 10 = Double Chance, 11 = Draw No Bet, 18 = Over/Under, 29 = GG/NG (BTTS)
const SPORTY_MARKETS = ['1', '10', '11', '18', '29'];

async function fetchSportyBetPage(pageNum, marketIds) {
  const markets = encodeURIComponent(marketIds.join(','));
  const url = `https://www.sportybet.com/api/gh/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=${markets}&pageSize=100&pageNum=${pageNum}&timeline=48&_t=${Date.now()}`;
  const headers = {
    Accept: '*/*',
    Clientid: 'web',
    'Current-Country': 'GH',
    Operid: '3',
    Platform: 'web',
    Referer: 'https://www.sportybet.com/gh/sport/football',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    Cookie: 'sb_country=gh; locale=en;',
  };
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) throw new Error(`SportyBet HTTP ${res.status} on page ${pageNum}`);
  return await res.json();
}

// Returns an array of tournaments (each with only in-window events)
async function fetchAllSportyBet(marketIds) {
  const seen = new Set();
  const allTournaments = [];
  let page = 1;
  const MAX_PAGES = 15;

  while (page <= MAX_PAGES) {
    console.log(`📄 SportyBet [markets ${marketIds.join(',')}] page ${page}...`);
    const data = await fetchSportyBetPage(page, marketIds);
    const tournaments = data.data?.tournaments || [];
    if (tournaments.length === 0) break;

    let freshEvents = 0;
    for (const t of tournaments) {
      const kept = [];
      for (const e of t.events || []) {
        const ts = e.estimateStartTime;
        if (!withinWindow(ts)) continue;
        if (seen.has(e.eventId)) continue;
        seen.add(e.eventId);
        kept.push(e);
        freshEvents++;
      }
      if (kept.length > 0) allTournaments.push({ ...t, events: kept });
    }

    const totalOnPage = tournaments.reduce((s, t) => s + (t.events?.length || 0), 0);
    console.log(`   → page ${page}: ${totalOnPage} events (${freshEvents} kept)`);

    if (totalOnPage < 100) break;
    page++;
    await sleep(1500);
  }

  return allTournaments;
}

// Which market IDs are present, and on how many events
function marketCoverage(tournaments) {
  const cov = new Map();
  for (const t of tournaments) {
    for (const e of t.events || []) {
      const ids = new Set((e.markets || []).map((m) => String(m.id)));
      for (const id of ids) cov.set(id, (cov.get(id) || 0) + 1);
    }
  }
  return cov;
}

// Copy markets from `extra` into the matching events of `base` (matched by eventId)
function mergeMarkets(base, extra) {
  const byId = new Map();
  for (const t of base) for (const e of t.events || []) byId.set(e.eventId, e);

  for (const t of extra) {
    for (const e of t.events || []) {
      const target = byId.get(e.eventId);
      if (!target) continue;
      if (!target.markets) target.markets = [];
      const have = new Set(target.markets.map((m) => `${m.id}|${(m.outcomes || []).map((o) => o.desc).join(',')}`));
      for (const m of e.markets || []) {
        const k = `${m.id}|${(m.outcomes || []).map((o) => o.desc).join(',')}`;
        if (have.has(k)) continue;
        target.markets.push(m);
        have.add(k);
      }
    }
  }
}

async function fetchSportyBetWithMarkets() {
  let tournaments = [];
  let combinedWorked = false;

  try {
    tournaments = await fetchAllSportyBet(SPORTY_MARKETS);
    const cov = marketCoverage(tournaments);
    combinedWorked = SPORTY_MARKETS.slice(1).some((id) => cov.has(id));
  } catch (e) {
    console.log(`   ⚠️  Combined request failed (${e.message}).`);
  }

  if (!combinedWorked) {
    console.log('   ⚠️  Combined market request gave only 1X2. Falling back to one request per market...');
    tournaments = await fetchAllSportyBet(['1']);
    for (const id of SPORTY_MARKETS.slice(1)) {
      await sleep(1500);
      try {
        const extra = await fetchAllSportyBet([id]);
        mergeMarkets(tournaments, extra);
        console.log(`   ✔ merged market ${id}`);
      } catch (e) {
        console.log(`   ✖ market ${id} failed: ${e.message}`);
      }
    }
  }

  const cov = marketCoverage(tournaments);
  const summary = [...cov.entries()].map(([id, n]) => `${id}: ${n} events`).join(' | ');
  console.log(`   Market coverage → ${summary || 'none'}`);
  return { data: { tournaments } };
}

// ============================================================================
// MSport
// ============================================================================
async function fetchMSportPage(lastEventId = null) {
  let url = 'https://www.msport.com/api/gh/facts-center/query/frontend/sports-matches-list?sportId=sr:sport:1';
  if (lastEventId) url += `&lastEventId=${encodeURIComponent(lastEventId)}`;

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    apilevel: '2',
    clientid: 'WEB',
    Operid: '3',
    Platform: 'WEB',
    Origin: 'https://www.msport.com',
    Referer: 'https://www.msport.com/gh/web/sports/list/Soccer',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify([]) });
  if (!res.ok) throw new Error(`MSport HTTP ${res.status}`);
  return await res.json();
}

async function fetchAllMSport() {
  const allTournaments = [];
  const seen = new Set();
  let lastEventId = null;
  let page = 1;
  const MAX_PAGES = 25; // Safety limit

  while (page <= MAX_PAGES) {
    console.log(`📄 MSport page ${page}...`);
    const data = await fetchMSportPage(lastEventId);

    const nextCursor = data.data?.lastEventId;
    const tournaments = data.data?.tournaments || [];
    if (tournaments.length === 0) break;

    let totalOnPage = 0;
    let freshEvents = 0;
    let allMatchesPastCutoff = true;

    for (const t of tournaments) {
      const kept = [];
      for (const e of t.events || []) {
        totalOnPage++;

        if (e.startTime <= CUTOFF) {
          allMatchesPastCutoff = false;
        }

        if (!withinWindow(e.startTime)) continue;

        const key = e.eventId || `${e.homeTeam}|${e.awayTeam}|${e.startTime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(e);
        freshEvents++;
      }
      if (kept.length > 0) allTournaments.push({ ...t, events: kept });
    }

    console.log(`   → page ${page}: ${totalOnPage} events (${freshEvents} kept)`);

    // Feed is sorted by time: once a whole page is past the window, stop.
    if (allMatchesPastCutoff && totalOnPage > 0) {
      console.log('   → Reached matches outside the 2-day window. Stopping.');
      break;
    }

    if (!nextCursor || nextCursor === lastEventId) {
      console.log('   → No more pages left.');
      break;
    }

    lastEventId = nextCursor;
    page++;
    await sleep(500);
  }

  return { data: { tournaments: allTournaments } };
}

// ============================================================================
// Main
// ============================================================================
async function run() {
  const outputDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Window: now → ${new Date(CUTOFF).toISOString()}\n`);

  try {
    console.log('🚀 Fetching SportyBet...');
    const sb = await fetchSportyBetWithMarkets();
    const sbCount = sb.data.tournaments.reduce((s, t) => s + (t.events?.length || 0), 0);
    fs.writeFileSync(path.join(outputDir, 'sportybet.json'), JSON.stringify(sb, null, 2));
    console.log(`✅ SportyBet: ${sbCount} matches within 2-day window\n`);
  } catch (e) {
    console.error('❌ SportyBet fetch failed:', e.message, '\n');
  }

  try {
    console.log('🚀 Fetching MSport...');
    const ms = await fetchAllMSport();
    const msCount = ms.data.tournaments.reduce((s, t) => s + (t.events?.length || 0), 0);
    fs.writeFileSync(path.join(outputDir, 'msport.json'), JSON.stringify(ms, null, 2));
    console.log(`✅ MSport: ${msCount} matches within 2-day window\n`);
  } catch (e) {
    console.error('❌ MSport fetch failed:', e.message, '\n');
  }

  console.log('🎉 Done.');
}

run();