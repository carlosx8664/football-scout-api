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

// ============================================================================
// SportyBet
// ============================================================================
async function fetchSportyBetPage(pageNum) {
  const url = `https://www.sportybet.com/api/gh/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=1&pageSize=100&pageNum=${pageNum}&timeline=48&_t=${Date.now()}`;
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

async function fetchAllSportyBet() {
  const seen = new Set();
  const allTournaments = [];
  let page = 1;
  const MAX_PAGES = 15;

  while (page <= MAX_PAGES) {
    console.log(`📄 SportyBet page ${page}...`);
    const data = await fetchSportyBetPage(page);
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
    await new Promise((r) => setTimeout(r, 1500));
  }

  return { data: { tournaments: allTournaments } };
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
    let allMatchesPastCutoff = true; // Tracks if we've gone past the 2-day window

    for (const t of tournaments) {
      const kept = [];
      for (const e of t.events || []) {
        totalOnPage++;
        
        // If ANY match on this page is within our 2-day window, we haven't passed the cutoff yet
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

    // SMART STOP: If every single match on this page is past our 48-hour window, 
    // then all matches on subsequent pages will also be past the window. We're done!
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
    await new Promise((r) => setTimeout(r, 500)); 
  }

  return { data: { tournaments: allTournaments } };
}

// ============================================================================
// Main
// ============================================================================
async function run() {
  const outputDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  console.log(`Window: now → ${new Date(CUTOFF).toISOString()}\n`);

  try {
    console.log('🚀 Fetching SportyBet...');
    const sb = await fetchAllSportyBet();
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