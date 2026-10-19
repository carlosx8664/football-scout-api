export async function onRequest(context) {
  const { env, request } = context;
  const apiKey = env.API_FOOTBALL_KEY;
  const groqKey = env.GROQ_API_KEY;

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key not found." }), { status: 500 });
  }

  // --- 1. SETUP CACHE ---
  // We create a unique cache key for today (e.g., "https://cache.internal/snapshot-2026-10-19")
  // This guarantees we don't serve yesterday's matches today.
  const today = new Date().toISOString().split('T')[0];
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/snapshot-${today}-v2`;
  const cacheKey = new Request(cacheUrl.toString(), request);
  const cache = caches.default;

  // --- 2. CHECK CACHE ---
  let cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    console.log("Serving from Cloudflare Cache - 0 API requests used");
    return cachedResponse;
  }

  // --- 3. FETCH FRESH DATA (If not in cache) ---
  console.log("Fetching fresh data from API-Football");
  const fixturesUrl = `https://v3.football.api-sports.io/fixtures?date=${today}`;

  try {
    const response = await fetch(fixturesUrl, {
      headers: { "x-apisports-key": apiKey },
    });
    const data = await response.json();

    let filteredMatches = data.response.filter(
      (match) => match.league.id === 39 || match.league.id === 140
    );

    if (filteredMatches.length > 0) {
      for (let i = 0; i < filteredMatches.length; i++) {
        let match = filteredMatches[i];
        const fixtureId = match.fixture.id;
        
        // Fetch Odds
        const oddsUrl = `https://v3.football.api-sports.io/odds?fixture=${fixtureId}`;
        const oddsResponse = await fetch(oddsUrl, {
          headers: { "x-apisports-key": apiKey },
        });
        const oddsData = await oddsResponse.json();
        
        let matchWinnerOdds = null;
        if (oddsData.response && oddsData.response.length > 0) {
          const bookmakerData = oddsData.response[0];
          if (bookmakerData.bookmakers && bookmakerData.bookmakers.length > 0) {
            const bet = bookmakerData.bookmakers[0].bets.find(b => b.id === 1);
            if (bet) matchWinnerOdds = bet.values;
          }
        }
        filteredMatches[i].odds = matchWinnerOdds;

        // AI Analysis via Cloudflare AI Gateway
        if (groqKey && matchWinnerOdds) {
          const homeTeam = match.teams.home.name;
          const awayTeam = match.teams.away.name;
          const homeOdd = matchWinnerOdds[0].odd;
          const awayOdd = matchWinnerOdds[2].odd;

          const prompt = `You are a football betting analyst. The match is ${homeTeam} vs ${awayTeam}. The odds are: ${homeTeam} to win: ${homeOdd}, ${awayTeam} to win: ${awayOdd}. 
          Based on your general knowledge of these teams' current form, injuries, and historical matchups, write a 2-sentence summary of why the bookmakers have priced the match this way. Keep it punchy and factual.`;

          try {
            // Notice the URL: we use the AI Gateway, and we removed /openai/v1
            const groqUrl = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/groq/chat/completions`;

            const groqResponse = await fetch(groqUrl, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${groqKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                model: "llama3-8b-8192",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 100
              })
            });
            
            const groqData = await groqResponse.json();
            
            if (groqData.choices && groqData.choices[0]) {
              filteredMatches[i].ai_analysis = groqData.choices[0].message.content;
            } else {
              console.log("Groq Error Response:", groqData);
              filteredMatches[i].ai_analysis = "AI analysis unavailable right now.";
            }
            
          } catch (err) {
            console.log("AI Fetch Error:", err);
            filteredMatches[i].ai_analysis = "AI analysis unavailable right now.";
          }
        }
      }
    }

    const requestsRemaining = response.headers.get("x-ratelimit-requests-remaining") || "Unknown";

    // --- 4. BUILD RESPONSE ---
    const finalData = {
      status: "success",
      date: today,
      quota_remaining: requestsRemaining,
      match_count: filteredMatches.length,
      matches: filteredMatches,
    };

    const newResponse = new Response(JSON.stringify(finalData), {
      headers: { "Content-Type": "application/json" },
    });

    // --- 5. SAVE TO CACHE ---
    // context.waitUntil allows the response to be sent to the user immediately, 
    // while Cloudflare saves it to the cache in the background.
    context.waitUntil(cache.put(cacheKey, newResponse.clone()));

    return newResponse;

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}