// scripts/fetch-odds.js
// Downloads the next 48h of football fixtures + odds from SportyBet, MSport and BetBoro
// into data/sportybet.json, data/msport.json and data/betboro.json.
//
//   node scripts/fetch-odds.js                 all three bookies
//   node scripts/fetch-odds.js --only=betboro  just one (sportybet | msport | betboro)
//   node scripts/fetch-odds.js --betboro-comps=403,84,526   only those BetBoro competitions
//   (BetBoro competitions come from BETBORO_REGIONS_URL if set, otherwise a built-in list)
//
// SportyBet asks for several markets (1X2, Double Chance, DNB, Over/Under, GG/NG). If SportyBet
// ignores the combined list, the script falls back to one request per market and merges by eventId.
// BetBoro matches are identified by their Sportradar id: sr:match:<external_id>.

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

  if (page > MAX_PAGES) {
    console.log(`   ⚠️  Stopped at the ${MAX_PAGES}-page safety limit, so some SportyBet matches may be missing.`);
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
  const MAX_PAGES = 80; // Safety limit (the loop normally stops itself well before this)

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

  if (page > MAX_PAGES) {
    console.log(`   ⚠️  Stopped at the ${MAX_PAGES}-page safety limit, so some MSport matches may be missing.`);
  }

  return { data: { tournaments: allTournaments } };
}

// ============================================================================
// BetBoro
// ============================================================================
// Competitions to fetch. Built-in snapshot of everything with pre-match fixtures on 23 Oct 2026
// (virtual Esoccer, Outrights and Specials left out). Override with --betboro-comps=403,84,526
const BETBORO_COMPETITIONS = [
  '24889', '26561', '871', '8668', '349', '825', '23661', '24738', '7259', '112',
  '224', '477', '2338', '2413', '588', '18767', '380', '8020', '23434', '32',
  '156', '167', '268', '8854', '8064', '1027', '350', '3719', '4160', '4977',
  '8429', '8762', '17218', '8059', '8098', '166', '179', '200', '4180', '4971',
  '25769', '277', '8159', '20768', '705', '4155', '144', '22108', '230', '483',
  '1341', '3902', '4166', '4199', '770', '4134', '137', '21238', '21239', '21242',
  '21244', '8055', '8128', '8260', '23296', '23328', '23330', '23419', '24832', '25585',
  '346', '382', '405', '3823', '4204', '8306', '557', '351', '59', '279',
  '462', '749', '84', '115', '228', '333', '403', '526', '539', '1042',
  '2679', '2963', '3607', '3609', '3665', '3723', '4206', '4494', '8030', '513',
  '16106', '2241', '7230', '7249', '13144', '20883', '436', '4272', '194', '309',
  '173', '189', '328', '804', '5927', '376', '1142', '51', '75', '125',
  '133', '214', '3482', '8196', '8391', '79', '8058', '8086', '865', '320',
  '965', '13499', '13927', '4633', '4804', '8473', '17671', '4376', '22034', '50',
  '207', '4623', '4776', '5190', '5694', '212', '263', '500', '771', '1048',
  '509', '8427', '25110', '25116', '303', '1503', '655', '29', '3686', '280',
  '321', '665', '824', '9146', '5487', '461', '566', '907', '8051', '22946',
  '26532', '4172', '238', '261', '919', '9780', '18867', '1673', '1678', '129',
  '878', '4133', '4203', '28', '1477', '8623', '39', '748', '1522', '239',
  '85', '97', '168', '249', '305', '8748', '203', '584', '3322', '3788',
  '8257', '8346', '3849', '172', '366', '4327', '8075', '94', '6697', '7330',
  '289', '364', '496', '585', '3119', '8543', '15', '361', '1618', '71',
  '106', '209', '4270', '40', '3502', '8620', '199', '4802', '4151', '4190',
  '33', '374', '44', '92', '4628', '5928', '7234', '8034', '8305', '9160',
  '81', '126', '154', '185', '246', '229', '304', '1918', '324', '139',
  '306', '404', '10193', '98', '110', '639', '17336', '680', '6693', '270',
  '8037', '4740', '16884', '508', '1731', '4235', '30', '3841', '12494',
];

// BetBoro's regions/competitions request: read on every run so new leagues are picked up and finished
// ones dropped. If it fails, the built-in snapshot above is used. Set to '' to always use the snapshot.
const BETBORO_REGIONS_URL = 'https://bs.betboro.com.gh/regions/competitions/sport/1';
const BETBORO_BATCH_SIZE = 8; // competitions per request (a 4-competition request is ~800 kB)

const betboroHeaders = () => ({
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en',
  'api-language': 'en',
  authorization: 'Bearer null',
  origin: 'https://betboro.com.gh',
  referer: 'https://betboro.com.gh/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  'x-requested-with': 'XMLHttpRequest',
});

async function fetchBetBoroBatch(ids) {
  const url = `https://bs.betboro.com.gh/sport/1/upcoming-events?sport_id=1&competition_ids=${ids.join(',')}&utc_offset=%2B00:00&pre_only=0`;
  const res = await fetch(url, { headers: betboroHeaders() });
  if (!res.ok) throw new Error(`BetBoro HTTP ${res.status} (competitions ${ids.join(',')})`);
  return await res.json(); // [{ competition_id, fixtures: { <id>: {...} } }, ...]
}

// regions list -> competition ids that have pre-match fixtures (skips virtual, outrights and specials)
function competitionsFromRegions(regions) {
  const ids = [];
  for (const region of Array.isArray(regions) ? regions : []) {
    if (/esoccer|virtual/i.test(region.name ?? '')) continue;
    for (const c of Object.values(region.competitions ?? {})) {
      if (!(c.pre_fixtures_count > 0)) continue;
      if (/outright|specials/i.test(c.name ?? '')) continue;
      ids.push(String(c.id));
    }
  }
  return ids;
}

async function discoverBetBoroCompetitions() {
  if (!BETBORO_REGIONS_URL) return null;
  try {
    const res = await fetch(BETBORO_REGIONS_URL, { headers: betboroHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = competitionsFromRegions(await res.json());
    if (!ids.length) throw new Error('no competitions found in response');
    return ids;
  } catch (e) {
    console.log(`   ⚠️  Could not read the regions list (${e.message}). Using the built-in snapshot instead.`);
    return null;
  }
}

// Outcome leaf -> small object. Line markets (e.g. total_goals) keep their nesting: line -> column -> outcome.
function compactMarket(node) {
  if (node && typeof node === 'object') {
    if ('price' in node) {
      return { name: node.name, short: node.name_short, price: node.price, status: node.status };
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = compactMarket(v);
    return out;
  }
  return node;
}

// Turn raw responses into a flat, compact list of real (non-outright, pre-match, in-window) fixtures
function collectBetBoro(responses) {
  const out = [];
  const seen = new Set();
  for (const resp of responses) {
    for (const comp of Array.isArray(resp) ? resp : []) {
      for (const f of Object.values(comp.fixtures ?? {})) {
        if (f.outright || f.live || !f.external_id) continue;
        if (!Array.isArray(f.participants) || f.participants.length < 2) continue;
        const kickoff = Date.parse(f.start_datetime);
        if (!withinWindow(kickoff)) continue;

        const eventId = `sr:match:${f.external_id}`;
        if (seen.has(eventId)) continue;
        seen.add(eventId);

        out.push({
          eventId,
          home: f.participants[0],
          away: f.participants[1],
          // BetBoro ships crests on the fixture; they fill gaps the other books leave blank.
          logos: {
            home: f.participant_logos?.home ?? '',
            away: f.participant_logos?.away ?? '',
          },
          kickoff,
          region: f.region_name,
          competition: f.competition_name,
          competitionId: String(f.competition_id),
          markets: compactMarket(f.overview_markets ?? {}),
        });
      }
    }
  }
  return out;
}

async function fetchAllBetBoro(competitionIds) {
  const responses = [];
  for (let i = 0; i < competitionIds.length; i += BETBORO_BATCH_SIZE) {
    const ids = competitionIds.slice(i, i + BETBORO_BATCH_SIZE);
    console.log(`📄 BetBoro competitions ${ids.join(',')}...`);
    try {
      const resp = await fetchBetBoroBatch(ids);
      responses.push(resp);
      console.log(`   → ${Array.isArray(resp) ? resp.length : 0} competitions returned`);
    } catch (e) {
      console.log(`   ⚠️  Batch failed (${e.message}). Retrying one competition at a time...`);
      for (const id of ids) {
        try {
          responses.push(await fetchBetBoroBatch([id]));
        } catch (e2) {
          console.log(`   ✖ competition ${id} failed: ${e2.message}`);
        }
        await sleep(1000);
      }
    }
    await sleep(1000);
  }
  return collectBetBoro(responses);
}

// ============================================================================
// Main
// ============================================================================
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ONLY = opt('only', 'all');
const want = (name) => ONLY === 'all' || ONLY === name;

async function run() {
  const outputDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Window: now → ${new Date(CUTOFF).toISOString()}\n`);

  // Offline helper: build data/betboro.json from raw responses you saved earlier
  const fromFiles = opt('betboro-from', '');
  if (fromFiles) {
    const responses = fromFiles.split(',').map((f) => JSON.parse(fs.readFileSync(f.trim(), 'utf8')));
    const fixtures = collectBetBoro(responses);
    fs.writeFileSync(path.join(outputDir, 'betboro.json'), JSON.stringify({ generatedAt: new Date().toISOString(), fixtures }));
    console.log(`✅ BetBoro (from files): ${fixtures.length} matches within 2-day window`);
    return;
  }

  if (want('sportybet')) {
    try {
      console.log('🚀 Fetching SportyBet...');
      const sb = await fetchSportyBetWithMarkets();
      const sbCount = sb.data.tournaments.reduce((s, t) => s + (t.events?.length || 0), 0);
      fs.writeFileSync(path.join(outputDir, 'sportybet.json'), JSON.stringify(sb, null, 2));
      console.log(`✅ SportyBet: ${sbCount} matches within 2-day window\n`);
    } catch (e) {
      console.error('❌ SportyBet fetch failed:', e.message, '\n');
    }
  }

  if (want('msport')) {
    try {
      console.log('🚀 Fetching MSport...');
      const ms = await fetchAllMSport();
      const msCount = ms.data.tournaments.reduce((s, t) => s + (t.events?.length || 0), 0);
      fs.writeFileSync(path.join(outputDir, 'msport.json'), JSON.stringify(ms, null, 2));
      console.log(`✅ MSport: ${msCount} matches within 2-day window\n`);
    } catch (e) {
      console.error('❌ MSport fetch failed:', e.message, '\n');
    }
  }

  if (want('betboro')) {
    try {
      console.log('🚀 Fetching BetBoro...');
      const override = opt('betboro-comps', '');
      let comps;
      if (override) {
        comps = override.split(',').map((x) => x.trim()).filter(Boolean);
        console.log(`   Using ${comps.length} competitions from --betboro-comps`);
      } else {
        const discovered = await discoverBetBoroCompetitions();
        comps = discovered ?? BETBORO_COMPETITIONS;
        console.log(`   Using ${comps.length} competitions (${discovered ? 'from the live regions list' : 'built-in snapshot'})`);
      }
      const fixtures = await fetchAllBetBoro(comps);
      fs.writeFileSync(path.join(outputDir, 'betboro.json'), JSON.stringify({ generatedAt: new Date().toISOString(), fixtures }));
      console.log(`✅ BetBoro: ${fixtures.length} matches within 2-day window\n`);
    } catch (e) {
      console.error('❌ BetBoro fetch failed:', e.message, '\n');
    }
  }

  console.log('🎉 Done.');
}

run();