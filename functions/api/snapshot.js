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
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const today = new Date().toISOString().split("T")[0];

  // Cache key (bump the version suffix if you ever need to invalidate everything)
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  cacheUrl.pathname = `/snapshot-${today}-v12`;
  const cacheKey = new Request(cacheUrl.toString());
  const cache = caches.default;

  if (!forceRefresh) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) return cachedResponse;
  }

  const apiHeaders = {
    "x-apisports-key": apiKey,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  };

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

    const filteredMatches = data.response.filter(
      (match) => match.league.id === 39 || match.league.id === 140
    );

    // Only cache the result if everything succeeded
    let cacheable = true;

    // ---------- 1) ODDS (sequential, spaced to respect 10 req/min) ----------
    for (let i = 0; i < filteredMatches.length; i++) {
      const match = filteredMatches[i];
      await sleep(6000);

      const oddsResponse = await fetch(
        `https://v3.football.api-sports.io/odds?fixture=${match.fixture.id}`,
        { headers: apiHeaders }
      );
      const oddsData = await oddsResponse.json();

      if (oddsData.errors && Object.keys(oddsData.errors).length > 0) {
        match.odds = null;
        match.ai_analysis = "Odds rate limited, try again later.";
        match._skipAI = true;
        cacheable = false;
        continue;
      }

      let matchWinnerOdds = null;
      if (oddsData.response && oddsData.response.length > 0) {
        const bookmakers = oddsData.response[0].bookmakers;
        if (bookmakers && bookmakers.length > 0) {
          const bet = bookmakers[0].bets.find((b) => b.id === 1);
          if (bet) matchWinnerOdds = bet.values;
        }
      }
      match.odds = matchWinnerOdds;
    }

    // ---------- 2) AI ANALYSIS (parallel, goes through AI Gateway) ----------
    if (groqKey && aigToken && accountId) {
      const groqUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/groq/chat/completions`;

      await Promise.all(
        filteredMatches.map(async (match) => {
          if (match._skipAI) return;

          const homeTeam = match.teams.home.name;
          const awayTeam = match.teams.away.name;
          const odds = match.odds;

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
                model: "openai/gpt-oss-20b",
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

            if (groqData && groqData.choices && groqData.choices[0]) {
              match.ai_analysis = groqData.choices[0].message.content;
            } else {
              cacheable = false;
              match.ai_analysis = `AI error (HTTP ${groqResponse.status}) via gateway "${gatewayId}": ${groqText.slice(0, 300)}`;
            }
          } catch (err) {
            cacheable = false;
            match.ai_analysis = "AI network fetch failed: " + err.message;
          }
        })
      );
    } else {
      const missing = [
        !groqKey && "GROQ_API_KEY",
        !aigToken && "CF_AIG_TOKEN",
        !accountId && "CF_ACCOUNT_ID",
      ].filter(Boolean);
      filteredMatches.forEach((m) => {
        m.ai_analysis = `AI skipped: missing variable(s) ${missing.join(", ")}`;
      });
      cacheable = false;
    }

    // Clean up internal flag before sending
    filteredMatches.forEach((m) => delete m._skipAI);

    const finalData = {
      status: "success",
      date: today,
      quota_remaining: requestsRemaining,
      match_count: filteredMatches.length,
      matches: filteredMatches,
    };

    const newResponse = new Response(JSON.stringify(finalData), {
      headers: {
        ...JSON_HEADERS,
        "Cache-Control": cacheable ? "public, max-age=3600" : "no-store",
      },
    });

    if (cacheable) {
      context.waitUntil(cache.put(cacheKey, newResponse.clone()));
    }

    return newResponse;
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
}