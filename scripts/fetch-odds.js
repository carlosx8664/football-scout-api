// scripts/fetch-odds.js
// Downloads the next 48h of football fixtures + odds from SportyBet, MSport, BetBoro and BoltBet
// into data/sportybet.json, data/msport.json, data/betboro.json, and data/boltbet.json.
//
//   node scripts/fetch-odds.js                 all four bookies
//   node scripts/fetch-odds.js --only=boltbet  just one (sportybet | msport | betboro | boltbet)
//   node scripts/fetch-odds.js --betboro-comps=403,84,526   only those BetBoro competitions

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { io } from 'socket.io-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const WINDOW_DAYS = Math.max(1, Number(opt('days', '2')) || 2);
const MARKET_MODE = opt('markets', 'all');
const FILE_SUFFIX = opt('suffix', '');

const LOOKAHEAD_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const NOW = Date.now();
const CUTOFF = NOW + LOOKAHEAD_MS;

function withinWindow(ts) {
  if (!ts) return false;
  return ts >= NOW - 60 * 60 * 1000 && ts <= CUTOFF;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// SportyBet
// ============================================================================
//
// NOTE: Aggregate team-level shots/SOT markets are NOT present in BetBoro's
// live `liveFixtureBook` payload — BetBoro only exposes per-player shots/SOT
// (external_id 2564/2565), which find-arbs.js does not currently consume.
//
const SPORTY_MARKETS = [
  '1', '10', '11', '18', '29', '16', '139', '166',
  '900319', // Total Tackles
  '900322', // Total Throw-Ins
  // '900394', '900393', '900552', '900553',
  // '900546', '900547', '900556', '900550',
];

async function fetchSportyBetPage(pageNum, marketIds) {
  const markets = encodeURIComponent(marketIds.join(','));
  const url = `https://www.sportybet.com/api/gh/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=${markets}&pageSize=100&pageNum=${pageNum}&timeline=${WINDOW_DAYS * 24}&_t=${Date.now()}`;
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

async function fetchAllSportyBet(marketIds) {
  const seen = new Set();
  const allTournaments = [];
  const MAX_PAGES = Math.ceil(WINDOW_DAYS / 2) * 15;
  const PAGE_BATCH_SIZE = 5;

  for (let batchStart = 1; batchStart <= MAX_PAGES; batchStart += PAGE_BATCH_SIZE) {
    const pages = Array.from(
      { length: Math.min(PAGE_BATCH_SIZE, MAX_PAGES - batchStart + 1) },
      (_, index) => batchStart + index,
    );
    const results = await Promise.all(
      pages.map(async (page) => {
        try {
          console.log(`📄 SportyBet [markets ${marketIds.join(',')}] page ${page}...`);
          return { page, data: await fetchSportyBetPage(page, marketIds) };
        } catch (error) {
          console.log(`   ⚠️  SportyBet page ${page} failed: ${error.message}`);
          return { page, data: null };
        }
      }),
    );
    let stop = false;

    for (const result of results) {
      const tournaments = result.data?.data?.tournaments || [];
      if (tournaments.length === 0) {
        stop = true;
        continue;
      }

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
      console.log(`   → page ${result.page}: ${totalOnPage} events (${freshEvents} kept)`);
      if (totalOnPage < 100) stop = true;
    }

    if (stop) break;
    if (batchStart + PAGE_BATCH_SIZE <= MAX_PAGES) await sleep(100);
  }

  if (allTournaments.length >= MAX_PAGES) {
    console.log(`   ⚠️  Stopped at the ${MAX_PAGES}-page safety limit.`);
  }

  return allTournaments;
}

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
  const marketIds = MARKET_MODE === '1x2' ? ['1'] : SPORTY_MARKETS;
  let tournaments = [];
  let combinedWorked = false;

  try {
    tournaments = await fetchAllSportyBet(marketIds);
    const cov = marketCoverage(tournaments);
    combinedWorked = marketIds.slice(1).some((id) => cov.has(id));
  } catch (e) {
    console.log(`   ⚠️  Combined request failed (${e.message}).`);
  }

  if (!combinedWorked && marketIds.length > 1) {
    console.log('   ⚠️  Combined market request gave only 1X2. Falling back...');
    tournaments = await fetchAllSportyBet(['1']);
    for (const id of marketIds.slice(1)) {
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

  // Rescue: ensure critical markets are present even if the combined request
  // dropped them. Tackles (900319) and Throw-Ins (900322) only appear close
  // to kickoff, so we always check coverage and refetch if missing.
  const rescueIds = ['16', '900319', '900322'];
  for (const id of rescueIds) {
    if (!marketIds.includes(id)) continue;

    const cov = marketCoverage(tournaments);
    const count = cov.get(id) || 0;

    if (count === 0) {
      console.log(`   ⚠️  Market ${id} missing from combined request, refetching separately...`);
      await sleep(1500);
      try {
        const extra = await fetchAllSportyBet([id]);
        mergeMarkets(tournaments, extra);
        const newCov = marketCoverage(tournaments);
        console.log(`   ✔ Market ${id} merged: ${newCov.get(id) || 0} matches`);
      } catch (e) {
        console.log(`   ✖ Market ${id} refetch failed: ${e.message}`);
      }
    }
  }

  const cov = marketCoverage(tournaments);
  console.log(`\n📊 SportyBet Market Coverage:`);
  const labels = {
    '1': '1X2', '10': 'Double Chance', '11': 'DNB', '18': 'O/U Goals',
    '29': 'BTTS', '16': 'Asian Handicap', '139': 'Bookings O/U', '166': 'Corners O/U',
    '900319': 'Tackles O/U', '900322': 'Throw-Ins O/U',
  };
  for (const id of marketIds) {
    const count = cov.get(id) || 0;
    console.log(`   - ${labels[id] || id}: ${count} matches`);
  }

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
  const MAX_PAGES = 80;

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
        if (e.startTime <= CUTOFF) allMatchesPastCutoff = false;
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
    if (allMatchesPastCutoff && totalOnPage > 0) break;
    if (!nextCursor || nextCursor === lastEventId) break;

    lastEventId = nextCursor;
    page++;
    await sleep(500);
  }

  return { data: { tournaments: allTournaments } };
}

// ============================================================================
// BetBoro (REST + WebSocket via socket.io-client)
// ============================================================================
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

const BETBORO_REGIONS_URL = 'https://bs.betboro.com.gh/regions/competitions/sport/1';
const BETBORO_BATCH_SIZE = 5;

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
  if (!res.ok) throw new Error(`BetBoro HTTP ${res.status}`);
  return await res.json();
}

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
    if (!ids.length) throw new Error('no competitions found');
    return ids;
  } catch (e) {
    return null;
  }
}

function compactMarket(node) {
  if (node && typeof node === 'object') {
    if ('price' in node) return { name: node.name, short: node.name_short, price: node.price, status: node.status };
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = compactMarket(v);
    return out;
  }
  return node;
}

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
          betBoroId: String(f.id),
          betBoroVirtualLiveId: f.virtual_live_id != null ? String(f.virtual_live_id) : null,
          betBoroExternalId: String(f.external_id),
          // Needed for the BetBoro deep link (region/competition/fixture URL shape).
          regionId: f.region_id != null ? String(f.region_id) : null,
          home: f.participants[0],
          away: f.participants[1],
          logos: { home: f.participant_logos?.home ?? '', away: f.participant_logos?.away ?? '' },
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
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          return await fetchBetBoroBatch([id]);
        } catch (error) {
          console.log(`   ⚠️  BetBoro competition ${id} failed: ${error.message}`);
          return null;
        }
      }),
    );
    responses.push(...results.filter(Boolean));
    if (i + BETBORO_BATCH_SIZE < competitionIds.length) await sleep(100);
  }
  return collectBetBoro(responses);
}

// ---------------------------------------------------------------------------
// liveFixtureBook → flat markets (v5 — adds total_tackles & total_throw_ins)
// ---------------------------------------------------------------------------
const BETBORO_FLAT_KEY_MAP = {
  '1':   { key: 'match_result',        kind: 'result' },
  '2':   { key: 'double_chance',       kind: 'result' },
  '7':   { key: 'both_teams_to_score', kind: 'btts'   },
  '6':   { key: 'total_goals',         kind: 'ou'     },
  '18':  { key: 'total_goals',         kind: 'ou'     },

  '1153': { key: 'total_corners',         kind: 'ou' },
  '166':  { key: 'total_corners',         kind: 'ou' },
  '1165': { key: 'total_cards',           kind: 'ou' },
  '139':  { key: 'total_cards',           kind: 'ou' },

  '1189': { key: 'total_shots',           kind: 'ou' },
  '1162': { key: 'total_shots_on_target', kind: 'ou' },

  '1244': { key: 'total_tackles',         kind: 'ou' },
  '1243': { key: 'total_throw_ins',       kind: 'ou' },
};

function parseBetBoroOuSide(odd) {
  const n = String(odd?.name ?? odd?.name_short ?? '').toLowerCase().trim();
  if (n.startsWith('over'))  return '0';
  if (n.startsWith('under')) return '1';
  if (n.startsWith('yes'))   return '0';
  if (n.startsWith('no'))    return '1';
  return null;
}

function parseBetBoroResultSlot(odd) {
  const c = Number(odd?.col);
  if (Number.isInteger(c)) return String(c);
  const s = String(odd?.name_short ?? '').toLowerCase().trim();
  if (s === '1') return '0';
  if (s === 'x' || s === 'draw') return '1';
  if (s === '2') return '2';
  if (s === 'yes') return '0';
  if (s === 'no')  return '1';
  if (s === '1x')  return '0';
  if (s === '12')  return '1';
  if (s === 'x2')  return '2';
  return null;
}

function extractLineFromOdd(odd) {
  const s = Number(odd?.sort);
  if (Number.isFinite(s) && s > 0 && Math.abs(s - Math.round(s)) > 1e-9) {
    return String(s);
  }
  const m = String(odd?.name ?? odd?.name_short ?? '').match(/(\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

function flattenLiveFixtureBook(payload) {
  const out = {};
  if (!payload || typeof payload.markets !== 'object') return out;

  for (const market of Object.values(payload.markets)) {
    if (!market) continue;
    if (market.visible === false) continue;

    const extId = String(market.external_id ?? '');
    const spec = BETBORO_FLAT_KEY_MAP[extId];
    if (!spec) continue;

    const odds = market.odds ?? {};

    if (spec.kind === 'result' || spec.kind === 'btts') {
      const bucket = out[spec.key] = out[spec.key] ?? {};
      for (const odd of Object.values(odds)) {
        if (!odd || odd.status !== 'available') continue;
        const slot = parseBetBoroResultSlot(odd);
        if (slot == null) continue;
        if (bucket[slot]) continue;
        bucket[slot] = { price: String(odd.price), status: 'available' };
      }
      continue;
    }

    if (spec.kind === 'ou') {
      const bucket = out[spec.key] = out[spec.key] ?? {};
      for (const odd of Object.values(odds)) {
        if (!odd || odd.status !== 'available') continue;
        const line = extractLineFromOdd(odd);
        if (!line || !line.endsWith('.5')) continue;
        const side = parseBetBoroOuSide(odd);
        if (side == null) continue;
        bucket[line] = bucket[line] ?? {};
        if (bucket[line][side]) continue;
        bucket[line][side] = { price: String(odd.price), status: 'available' };
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// WebSocket enrichment (v5)
//
// Browser capture confirmed the correct emit shape:
//   socket.emit('join-liveFixtureBook', '93917479')
//
// v5 expands DEEP_IDS to include Tackles (900319) and Throw-Ins (900322)
// so the WS subscribes to fixtures that SportyBet has these markets for.
// ---------------------------------------------------------------------------
function fetchBetBoroWebSockets(fixtures, sportyTournaments) {
  if (!fixtures || fixtures.length === 0) return Promise.resolve(new Map());
  if (!sportyTournaments || sportyTournaments.length === 0) {
    console.log('   ℹ️  No SportyBet data available; skipping WebSocket enrichment.');
    return Promise.resolve(new Map());
  }

  const DEEP_IDS = new Set(['139', '166', '900319', '900322']);
  const deepIds = new Set();
  for (const t of sportyTournaments) {
    for (const e of t.events ?? []) {
      for (const m of e.markets ?? []) {
        if (DEEP_IDS.has(String(m.id))) { deepIds.add(e.eventId); break; }
      }
    }
  }

  const targets = fixtures.filter((f) => deepIds.has(f.eventId));
  if (targets.length === 0) {
    console.log('   ℹ️  No fixtures with deep markets to enrich via WebSocket.');
    return Promise.resolve(new Map());
  }

  console.log(`   🔌 Opening socket.io connection, subscribing to ${targets.length} fixtures...`);

  return new Promise((resolve) => {
    const payloads = new Map();
    let resolved = false;

    const finish = (reason) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      console.log(`   ⏱️  Socket ${reason}. Collected ${payloads.size}/${targets.length}.`);
      if (payloads.size === 0) {
        console.log('   ⚠️  0 payloads received — server did not accept any id shape we tried.');
        const sample = targets.slice(0, 3).map((t) =>
          `${t.eventId} (betBoroId=${t.betBoroId}, vLive=${t.betBoroVirtualLiveId ?? '∅'}, ext=${t.betBoroExternalId})`);
        if (sample.length) console.log(`       samples: ${sample.join(' | ')}`);
      }
      resolve(payloads);
    };

    const socket = io('wss://bs.betboro.com.gh/sb-en', {
      path: '/socket/',
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 15000,
      query: { EIO: '4', transport: 'websocket' },
    });

    const timeout = setTimeout(() => finish('timeout'), 25000);

    socket.on('connect', () => {
      console.log(`   ✅ Connected (sid: ${socket.id})`);
      let i = 0;
      let logged = 0;
      const sendNext = () => {
        if (i >= targets.length || resolved) return;
        const t = targets[i++];

        const idCandidates = [];
        if (t.betBoroId)             idCandidates.push(String(t.betBoroId));
        if (t.betBoroVirtualLiveId)  idCandidates.push(String(t.betBoroVirtualLiveId));
        if (t.betBoroExternalId)     idCandidates.push(String(t.betBoroExternalId));

        if (logged < 3) {
          console.log(`      ↪ emit join-liveFixtureBook ${t.eventId} with ids [${idCandidates.join(',')}]`);
          logged++;
        }

        for (const id of idCandidates) {
          socket.emit('join-liveFixtureBook', id);
        }
        setTimeout(sendNext, 40);
      };
      sendNext();
    });

    socket.on('liveFixtureBook', (payload) => {
      if (!payload) return;
      const keys = [];
      if (payload.external_id != null)     keys.push(`sr:match:${payload.external_id}`);
      if (payload.virtual_live_id != null) keys.push(`vLive:${payload.virtual_live_id}`);
      if (payload.id != null)              keys.push(`betBoro:${payload.id}`);
      if (!keys.length) return;

      for (const k of keys) payloads.set(k, payload);

      const extIds = Object.values(payload.markets ?? {})
        .map((m) => m.external_id)
        .filter((v) => v != null);
      const uniqueExtIds = Array.from(new Set(extIds)).sort((a, b) => Number(a) - Number(b));
      console.log(
        `   📥 liveFixtureBook id=${payload.id} ext=${payload.external_id} vLive=${payload.virtual_live_id} → external_ids: ${uniqueExtIds.join(',')}`,
      );

      if (payloads.size >= targets.length) {
        clearTimeout(timeout);
        try { socket.close(); } catch {}
        console.log(`   ✅ Socket received ${targets.length} fixtures.`);
        resolved = true;
        resolve(payloads);
      }
    });

    socket.on('liveFixtureBookUpdate', (payload) => {
      if (!payload) return;
      // Deltas aren't merged — the full liveFixtureBook payload is authoritative.
    });

    socket.on('connect_error', (err) => {
      console.log(`   ⚠️  Socket connect_error: ${err.message}`);
      finish('connect_error');
    });

    socket.on('error', (err) => {
      console.log(`   ⚠️  Socket error: ${err.message || err}`);
    });

    socket.on('disconnect', (reason) => {
      if (reason === 'io client disconnect' || reason === 'io server disconnect') return;
      finish(`disconnected (${reason})`);
    });
  });
}

// ============================================================================
// BoltBet
// ============================================================================
async function fetchAllBoltBet() {
  const headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'origin': 'https://eu01.sportsbook.adv.bet',
    'referer': 'https://eu01.sportsbook.adv.bet/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
    'x-website-id': '17e5b1b7-bb38-d332-4e2f-f1fde542b6b9'
  };

  let allEvents = [];
  const chunks = 4;
  const chunkMs = (WINDOW_DAYS * 24 * 60 * 60 * 1000) / chunks;

  for (let i = 0; i < chunks; i++) {
    const chunkStart = NOW + (i * chunkMs);
    const chunkEnd = NOW + ((i + 1) * chunkMs);

    const fromDate = new Date(chunkStart).toISOString().split('.')[0] + 'Z';
    const toDate = new Date(chunkEnd).toISOString().split('.')[0] + 'Z';

    const url = `https://sportsbook-eu01-backend.advbet.com/distributor/api/organizations/17e5b1b7-bb38-d332-4e2f-f1fde542b6b9/events?filter.sports=football&filter.types=match&filter.closesAt.from=${fromDate}&filter.closesAt.to=${toDate}&sortBy=closes_at&sortBy=tournament&cursor.limit=100&view=full`;

    console.log(`📄 BoltBet chunk ${i + 1}/${chunks} (${fromDate} to ${toDate})...`);
    const res = await fetch(url, { method: 'GET', headers });

    if (!res.ok) {
      console.log(`   ⚠️ Chunk ${i + 1} failed with HTTP ${res.status}`);
      continue;
    }

    const data = await res.json();
    const events = data.result || [];

    let added = 0;
    for (const e of events) {
      if (e.fixture && !allEvents.some(existing => existing.fixture.uuid === e.fixture.uuid)) {
        allEvents.push(e);
        added++;
      }
    }

    console.log(`   → chunk ${i + 1}: ${events.length} events (${added} new, ${allEvents.length} total)`);
    await sleep(500);
  }

  return { events: allEvents };
}

// ============================================================================
// Main
// ============================================================================
const ONLY = opt('only', 'all');
const want = (name) => ONLY === 'all' || ONLY === name;

async function run() {
  const outputDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outFile = (name) => path.join(outputDir, `${name}${FILE_SUFFIX}.json`);

  console.log(`Window: now → ${new Date(CUTOFF).toISOString()} (${WINDOW_DAYS} days, markets: ${MARKET_MODE})\n`);

  const fromFiles = opt('betboro-from', '');
  if (fromFiles) {
    const responses = fromFiles.split(',').map((f) => JSON.parse(fs.readFileSync(f.trim(), 'utf8')));
    const fixtures = collectBetBoro(responses);
    fs.writeFileSync(outFile('betboro'), JSON.stringify({ generatedAt: new Date().toISOString(), fixtures }));
    console.log(`✅ BetBoro (from files): ${fixtures.length} matches within ${WINDOW_DAYS}-day window`);
    return;
  }

  let sportyTournaments = [];
  if (want('sportybet')) {
    try {
      console.log('🚀 Fetching SportyBet...');
      const sb = await fetchSportyBetWithMarkets();
      sportyTournaments = sb.data.tournaments;
      const sbCount = sportyTournaments.reduce((s, t) => s + (t.events?.length || 0), 0);
      fs.writeFileSync(outFile('sportybet'), JSON.stringify(sb, null, 2));
      console.log(`✅ SportyBet: ${sbCount} total matches saved.\n`);
    } catch (e) {
      console.error('❌ SportyBet fetch failed:', e.message, '\n');
    }
  }

  if (want('msport')) {
    try {
      console.log('🚀 Fetching MSport...');
      const ms = await fetchAllMSport();
      const msCount = ms.data.tournaments.reduce((s, t) => s + (t.events?.length || 0), 0);
      fs.writeFileSync(outFile('msport'), JSON.stringify(ms, null, 2));
      console.log(`✅ MSport: ${msCount} total matches saved.\n`);
    } catch (e) {
      console.error('❌ MSport fetch failed:', e.message, '\n');
    }
  }

  if (want('betboro')) {
    try {
      console.log('🚀 Fetching BetBoro (REST)...');
      const override = opt('betboro-comps', '');
      let comps;
      if (override) {
        comps = override.split(',').map((x) => x.trim()).filter(Boolean);
      } else {
        const discovered = await discoverBetBoroCompetitions();
        comps = discovered ?? BETBORO_COMPETITIONS;
      }
      const fixtures = await fetchAllBetBoro(comps);
      console.log(`   → REST returned ${fixtures.length} fixtures.\n`);

      if (sportyTournaments.length === 0) {
        console.log('   ⚠️  SportyBet data not loaded; skipping WebSocket enrichment.');
      } else {
        const wsPayloads = await fetchBetBoroWebSockets(fixtures, sportyTournaments);
        let enriched = 0;
        const keyCounts = {};
        for (const f of fixtures) {
          const payload =
            wsPayloads.get(f.eventId)
            ?? (f.betBoroVirtualLiveId ? wsPayloads.get(`vLive:${f.betBoroVirtualLiveId}`) : null)
            ?? wsPayloads.get(`betBoro:${f.betBoroId}`);
          if (!payload) continue;
          const flat = flattenLiveFixtureBook(payload);
          for (const [k, v] of Object.entries(flat)) {
            f.markets[k] = v;
            keyCounts[k] = (keyCounts[k] || 0) + 1;
          }
          enriched++;
        }
        console.log(`   ✅ Enriched ${enriched}/${fixtures.length} fixtures with live payloads.`);
        if (Object.keys(keyCounts).length > 0) {
          console.log('   📊 Market keys written:',
            Object.entries(keyCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => `${k}=${n}`)
              .join('  '));
        }
      }

      fs.writeFileSync(outFile('betboro'), JSON.stringify({ generatedAt: new Date().toISOString(), fixtures }));
      console.log(`✅ BetBoro: ${fixtures.length} total matches saved.\n`);
    } catch (e) {
      console.error('❌ BetBoro fetch failed:', e.message, '\n');
    }
  }

  if (want('boltbet')) {
    try {
      console.log('🚀 Fetching BoltBet...');
      const bb = await fetchAllBoltBet();
      fs.writeFileSync(outFile('boltbet'), JSON.stringify({ events: bb.events }, null, 2));
      console.log(`✅ BoltBet: ${bb.events.length} total matches saved.\n`);
    } catch (e) {
      console.error('❌ BoltBet fetch failed:', e.message, '\n');
    }
  }

  console.log('🎉 Done.');
}

run();