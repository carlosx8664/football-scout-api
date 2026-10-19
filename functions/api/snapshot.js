const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const JSON_HEADERS = { "Content-Type": "application/json" };

export async function onRequest(context) {
  const { env, request } = context;
  const apiKey = env.API_FOOTBALL_KEY;
  const groqKey = env.GROQ_API_KEY;
  const accountId = (env.CF_ACCOUNT_ID || "").trim();
  const gatewayId = (env.CF_GATEWAY_ID || "default").trim();
  const aigToken = (env.CF_AIG_TOKEN || "").trim();

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "API_FOOTBALL_KEY not found in Cloudflare Variables." }),
      { status: 500, headers: JSON_HEADERS }
    );
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh");
  const skipSnapshotCache = refresh === "1" || refresh === "all";
  const skipMatchCache = refresh === "all";

  const today = new Date().toISOString().split("T")[0];
  const cache = caches.default;

  const makeKey = (path) => {
    const u = new URL(request.url);
    u.search = "";
    u.pathname = path;
    return new Request(u.toString());
  };
  
  // Bumped to v13 to force a fresh build with the 10 leagues
  const snapshotKey = makeKey(`/snapshot-${today}-v13`);
  const matchKey = (id) => makeKey(`/match-${today}-${id}-v1`);

  if (!skipSnapshotCache) {
    const cachedResponse = await cache.match(snapshotKey);
    if (cachedResponse) return cachedResponse;
  }

  const apiHeaders = {
    "x-apisports-key": apiKey,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  };

  async function fetchOdds(fixtureId) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(
        `https://v3.football.api-sports.io/odds?fixture=${fixtureId}`,
        { headers: apiHeaders }
      );
      const json = await res.json();

      if (json.errors && Object.keys(json.errors).length > 0) {
        const detail = JSON.stringify(json.errors);
        const dailyLimit =
          "requests" in json.errors || /day/i.test(detail);
        if (attempt === 0 && !dailyLimit) {
          await sleep(15000); 
          continue;
        }
        return { error: detail };
      }
      return { json };
    }
    return { error: "Unknown odds error" };
  }

  try {
    const response = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${today}`,
      { headers: apiHeaders }
    );
    const data = await response.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      return new Response(
        JSON.stringify({ message: "API-Football Rejected: " + JSON.stringify(data.errors) }),
        { status: 400, headers: JSON_HEADERS }
      );
    }
    if (!data.response) {
      return new Response(
        JSON.stringify({ error: "API returned no 'response' field" }),
        { status: 500, headers: JSON_HEADERS }
      );
    }

    const requestsRemaining =
      response.headers.get("x-ratelimit-requests-remaining") || "Unknown";

    // The 10 target leagues
    const targetLeagues = [39, 135, 78, 140, 61, 71, 94, 144, 88, 40];

    const matches = data.response.filter(
      (m) => targetLeagues.includes(m.league.id)
    );

    let cacheable = true;

    if (!skipMatchCache) {
      await Promise.all(
        matches.map(async (m) => {
          const hit = await cache.match(matchKey(m.fixture.id));
          if (hit) {
            const saved = await hit.json();
            m.odds = saved.odds;
            m.ai_analysis = saved.ai_analysis;
            m._done = true;
          }
        })
      );
    }

    for (const m of matches) {
      if (m._done) continue;
      await sleep(6000);

      const result = await fetchOdds(m.fixture.id);
      if (result.error) {
        m.odds = null;
        m.ai_analysis = "Odds unavailable: " + result.error;
        m._skipAI = true;
        cacheable = false;
        continue;
      }

      let matchWinnerOdds = null;
      const resp = result.json.response;
      if (resp && resp.length > 0) {
        const bookmakers = resp[0].bookmakers;
        if (bookmakers && bookmakers.length > 0) {
          const bet = bookmakers[0].bets.find((b) => b.id === 1);
          if (bet) matchWinnerOdds = bet.values;
        }
      }
      m.odds = matchWinnerOdds;
    }

    const needsAI = matches.filter((m) => !m._done && !m._skipAI);

    if (groqKey && aigToken && accountId) {
      const groqUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/groq/chat/completions`;

      await Promise.all(
        needsAI.map(async (m) => {
          const homeTeam = m.teams.home.name;
          const awayTeam = m.teams.away.name;
          const odds = m.odds;

          let oddsText = "Odds are not yet available for this match.";
          if (odds && odds.length >= 3) {
            oddsText = `The current odds are: ${homeTeam} to win: ${odds[0].odd}, Draw: ${odds[1].odd}, ${awayTeam} to win: ${odds[2].odd}.`;
          }

          const prompt = `You are a football betting analyst. The match is ${homeTeam} vs ${awayTeam}. ${oddsText} Based on your general knowledge, write a 2-sentence summary.`;

          try {
            const groqResponse = await fetch(groqUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${groqKey}`,
                "cf-aig-authorization": `Bearer ${aigToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "openai/gpt-oss-20b", // Your chosen model
                messages: [{ role: "user", content: prompt }],
                reasoning_effort: "low",
                max_tokens: 600,
              }),
            });

            const groqText = await groqResponse.text();
            let groqData = null;
            try {
              groqData = JSON.parse(groqText);
            } catch (_) {}

            const content = groqData?.choices?.[0]?.message?.content;
            if (content) {
              m.ai_analysis = content;
              m._aiOk = true;
            } else {
              cacheable = false;
              m.ai_analysis = `AI error (HTTP ${groqResponse.status}) via gateway "${gatewayId}": ${groqText.slice(0, 300)}`;
            }
          } catch (err) {
            cacheable = false;
            m.ai_analysis = "AI network fetch failed: " + err.message;
          }
        })
      );
    } else {
      const missing = [
        !groqKey && "GROQ_API_KEY",
        !aigToken && "CF_AIG_TOKEN",
        !accountId && "CF_ACCOUNT_ID",
      ].filter(Boolean);
      needsAI.forEach((m) => {
        m.ai_analysis = `AI skipped: missing variable(s) ${missing.join(", ")}`;
      });
      cacheable = false;
    }

    for (const m of matches) {
      if (!m._done && m.odds && m._aiOk) {
        context.waitUntil(
          cache.put(
            matchKey(m.fixture.id),
            new Response(
              JSON.stringify({ odds: m.odds, ai_analysis: m.ai_analysis }),
              { headers: { ...JSON_HEADERS, "Cache-Control": "public, max-age=43200" } }
            )
          )
        );
      }
      if (!m.odds) cacheable = false;
    }

    matches.forEach((m) => {
      delete m._done;
      delete m._skipAI;
      delete m._aiOk;
    });

    const finalData = {
      status: "success",
      date: today,
      quota_remaining: requestsRemaining,
      match_count: matches.length,
      matches,
    };

    const newResponse = new Response(JSON.stringify(finalData), {
      headers: {
        ...JSON_HEADERS,
        "Cache-Control": cacheable ? "public, max-age=3600" : "no-store",
      },
    });

    if (cacheable) {
      context.waitUntil(cache.put(snapshotKey, newResponse.clone()));
    }

    return newResponse;
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
}