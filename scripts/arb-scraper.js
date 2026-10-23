console.log("🚀 Starting Arb Scraper (SportyBet vs MSport)...");

async function fetchSportyBetPage(pageNum) {
  const url = `https://www.sportybet.com/api/gh/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=1&pageSize=100&pageNum=${pageNum}&timeline=24&_t=${Date.now()}`;
  const headers = {
    "Accept": "*/*",
    "Clientid": "web",
    "Current-Country": "GH",
    "Operid": "3",
    "Platform": "web",
    "Referer": "https://www.sportybet.com/gh/sport/football",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
    "Cookie": "sb_country=gh; locale=en;"
  };
  
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) throw new Error(`SportyBet HTTP ${res.status} on page ${pageNum}`);
  const data = await res.json();
  return data;
}

async function fetchAllSportyBet() {
  let allMatches = {};
  let totalPages = 1;
  
  for (let page = 1; page <= totalPages && page <= 5; page++) {
    console.log(`   📄 Fetching SportyBet page ${page}...`);
    const data = await fetchSportyBetPage(page);
    
    // Check how many pages exist
    if (data.paging && data.paging.total) {
      totalPages = data.paging.total;
    }
    
    const parsed = parseSportyBet(data);
    Object.assign(allMatches, parsed);
    
    console.log(`      → ${Object.keys(parsed).length} matches from this page`);
  }
  
  return allMatches;
}

async function fetchMSport() {
  const url = "https://www.msport.com/api/gh/facts-center/query/frontend/sports-matches-list?sportId=sr:sport:1";
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "apilevel": "2",
    "clientid": "WEB",
    "Operid": "3",
    "Platform": "WEB",
    "Origin": "https://www.msport.com",
    "Referer": "https://www.msport.com/gh/web/sports/list/Soccer",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
  };
  
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify([]) });
  if (!res.ok) throw new Error(`MSport HTTP ${res.status}`);
  const data = await res.json();
  return parseMSport(data);
}

function parseSportyBet(data) {
  const matches = {};
  const tournaments = data.data?.tournaments || [];
  for (const t of tournaments) {
    for (const e of (t.events || [])) {
      const market = e.markets?.find(m => m.id === "1");
      if (!market) continue;
      
      const home = market.outcomes.find(o => o.id === "1");
      const draw = market.outcomes.find(o => o.id === "2");
      const away = market.outcomes.find(o => o.id === "3");

      if (home && draw && away) {
        const key = `${e.homeTeamName.toLowerCase()}|${e.awayTeamName.toLowerCase()}`;
        matches[key] = {
          homeTeam: e.homeTeamName,
          awayTeam: e.awayTeamName,
          SportyBet: { home: parseFloat(home.odds), draw: parseFloat(draw.odds), away: parseFloat(away.odds) }
        };
      }
    }
  }
  return matches;
}

function parseMSport(data) {
  const matches = {};
  const tournaments = data.data?.tournaments || [];
  
  for (const t of tournaments) {
    const events = t.events || [];
    for (const e of events) {
      const homeName = e.homeTeam;
      const awayName = e.awayTeam;
      if (!homeName || !awayName) continue;

      const market = e.markets?.find(m => m.id === 1);
      if (!market || !market.outcomes) continue;

      const home = market.outcomes.find(o => o.id === "1" || o.description === "Home");
      const draw = market.outcomes.find(o => o.id === "2" || o.description === "Draw");
      const away = market.outcomes.find(o => o.id === "3" || o.description === "Away");

      if (home && draw && away) {
        const key = `${homeName.toLowerCase()}|${awayName.toLowerCase()}`;
        matches[key] = {
          homeTeam: homeName,
          awayTeam: awayName,
          MSport: { home: parseFloat(home.odds), draw: parseFloat(draw.odds), away: parseFloat(away.odds) }
        };
      }
    }
  }
  return matches;
}

function normalizeName(name) {
  return name.toLowerCase()
    .replace(/\b(fc|cf|sc|afc|united|utd|city|town)\b/g, '') 
    .replace(/[^a-z0-9]/g, '') 
    .trim();
}

async function runArbScan() {
  let sb = {}, ms = {};

  try {
    console.log("📡 Fetching ALL SportyBet matches...");
    sb = await fetchAllSportyBet();
    console.log(`   ✅ Got ${Object.keys(sb).length} total matches from SportyBet`);
  } catch (e) { console.log("⚠️ SportyBet failed:", e.message); }
  
  try {
    console.log("\n📡 Fetching MSport...");
    ms = await fetchMSport();
    console.log(`   ✅ Got ${Object.keys(ms).length} matches from MSport`);
  } catch (e) { console.log("⚠️ MSport failed:", e.message); }

  // Debug: Show some team names
  console.log("\n🔍 SPORTYBET TEAMS (First 5):");
  Object.values(sb).slice(0, 5).forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.homeTeam} vs ${m.awayTeam}`);
  });

  console.log("\n🔍 MSPORT TEAMS (First 5):");
  Object.values(ms).slice(0, 5).forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.homeTeam} vs ${m.awayTeam}`);
  });

  // Find overlaps
  let overlapCount = 0;
  const arbs = [];

  for (const [sbKey, sbMatch] of Object.entries(sb)) {
    const [sbHome, sbAway] = sbKey.split('|');
    
    const msKey = Object.keys(ms).find(key => {
      const [msHome, msAway] = key.split('|');
      return normalizeName(sbHome) === normalizeName(msHome) && 
             normalizeName(sbAway) === normalizeName(msAway);
    });

    if (!msKey) continue; 
    overlapCount++;

    const msMatch = ms[msKey];
    const sbData = sbMatch.SportyBet;
    const msData = msMatch.MSport;

    const bestHome = Math.max(sbData.home, msData.home);
    const bestDraw = Math.max(sbData.draw, msData.draw);
    const bestAway = Math.max(sbData.away, msData.away);

    const impliedProb = (1 / bestHome) + (1 / bestDraw) + (1 / bestAway);

    if (impliedProb < 1.00) {
      const profitPercent = ((1 / impliedProb) - 1) * 100;
      arbs.push({
        match: `${sbMatch.homeTeam} vs ${sbMatch.awayTeam}`,
        profit: profitPercent.toFixed(2) + "%",
        bestOdds: { home: bestHome, draw: bestDraw, away: bestAway }
      });
    }
  }

  console.log(`\n🔗 MATCHED OVERLAPS: ${overlapCount} matches found across both bookies`);
  
  console.log(`\n🎉 Scan Complete!`);
  console.log(`Arbitrage opportunities found: ${arbs.length}\n`);
  
  if (arbs.length > 0) {
    arbs.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));
    console.log(arbs);
  } else {
    console.log("No arbs found right now.");
  }
}

runArbScan();