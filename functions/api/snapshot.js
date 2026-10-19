export async function onRequest(context) {
  const { env, request } = context;
  const apiKey = env.API_FOOTBALL_KEY;
  const groqKey = env.GROQ_API_KEY;

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key not found in Cloudflare Variables." }), { status: 500 });
  }

  const today = new Date().toISOString().split('T')[0];
  
  // Bumped to v9 to force a fresh run and clear the 401 error cache
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/snapshot-${today}-v9`; 
  const cacheKey = new Request(cacheUrl.toString(), request);
  const cache = caches.default;

  let cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return cachedResponse;
  }

  const fixturesUrl = `https://v3.football.api-sports.io/fixtures?date=${today}`;

  try {
    const response = await fetch(fixturesUrl, {
      headers: { "x-apisports-key": apiKey },
    });
    
    const data = await response.json();

    // --- ERROR CHECK ---
    if (data.errors && Object.keys(data.errors).length > 0) {
      return new Response(JSON.stringify({ 
        status: "error",
        message: "API-Football Rejected the Request",
        details: data.errors,
        apiKeyUsed: apiKey ? "Key is present" : "Key is missing"
      }), { status: 400, headers: { "Content-Type": "application/json" } }); 
    }

    if (!data.response) {
       return new Response(JSON.stringify({ error: "API returned no 'response' field" }), { status: 500 });
    }

    let filteredMatches = data.response.filter(
      (match) => match.league.id === 39 || match.league.id === 140
    );

    if (filteredMatches.length > 0) {
      for (let i = 0; i < filteredMatches.length; i++) {
        let match = filteredMatches[i];
        const fixtureId = match.fixture.id;
        
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

        // --- AI ANALYSIS (With Cloudflare AI Gateway Authorization) ---
        if (groqKey && env.CF_AIG_TOKEN) {
          const homeTeam = match.teams.home.name;
          const awayTeam = match.teams.away.name;
          
          let oddsText = "Odds are not yet available for this match.";
          if (matchWinnerOdds && matchWinnerOdds.length >= 3) {
             oddsText = `The current odds are: ${homeTeam} to win: ${matchWinnerOdds[0].odd}, Draw: ${matchWinnerOdds[1].odd}, ${awayTeam} to win: ${matchWinnerOdds[2].odd}.`;
          }

          const prompt = `You are a football betting analyst. The match is ${homeTeam} vs ${awayTeam}. ${oddsText} Based on your general knowledge, write a 2-sentence summary.`;

          try {
            const groqUrl = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/groq/chat/completions`;

            const groqResponse = await fetch(groqUrl, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${groqKey}`,
                "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`, // <-- NEW AUTHENTICATION TOKEN
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                model: "llama3-8b-8192",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 100
              })
            });
            
            // Read as text first to prevent JSON parsing crash
            const groqText = await groqResponse.text();
            
            try {
                const groqData = JSON.parse(groqText);
                if (groqData.choices && groqData.choices[0]) {
                  filteredMatches[i].ai_analysis = groqData.choices[0].message.content;
                } else {
                  filteredMatches[i].ai_analysis = "AI Error Response: " + groqText;
                }
            } catch (parseError) {
                filteredMatches[i].ai_analysis = "Invalid AI format: " + groqText;
            }
            
          } catch (err) {
            filteredMatches[i].ai_analysis = "AI network fetch failed.";
          }
        }
      }
    }

    const requestsRemaining = response.headers.get("x-ratelimit-requests-remaining") || "Unknown";

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

    context.waitUntil(cache.put(cacheKey, newResponse.clone()));

    return newResponse;

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}