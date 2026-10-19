export async function onRequest(context) {
  const { env } = context;
  const apiKey = env.API_FOOTBALL_KEY;
  const groqKey = env.GROQ_API_KEY;

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key not found." }), { status: 500 });
  }

  const today = new Date().toISOString().split('T')[0];
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
        
        // --- FETCH ODDS ---
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

        // --- AI NEWS ANALYSIS (Using Groq) ---
        // We only do this if we have the Groq key and if odds exist
        if (groqKey && matchWinnerOdds) {
          const homeTeam = match.teams.home.name;
          const awayTeam = match.teams.away.name;
          const homeOdd = matchWinnerOdds[0].odd;
          const awayOdd = matchWinnerOdds[2].odd;

          const prompt = `You are a football betting analyst. The match is ${homeTeam} vs ${awayTeam}. The odds are: ${homeTeam} to win: ${homeOdd}, ${awayTeam} to win: ${awayOdd}. 
          Based on your general knowledge of these teams' current form, injuries, and historical matchups, write a 2-sentence summary of why the bookmakers have priced the match this way. Keep it punchy and factual.`;

          try {
            const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${groqKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                model: "llama3-8b-8192", // Fast, free model
                messages: [{ role: "user", content: prompt }],
                max_tokens: 100
              })
            });
            const groqData = await groqResponse.json();
            
            // Attach the AI analysis to the match data
            filteredMatches[i].ai_analysis = groqData.choices[0].message.content;
            
          } catch (err) {
            console.log("AI Error:", err);
            filteredMatches[i].ai_analysis = "AI analysis unavailable right now.";
          }
        }
      }
    }

    const requestsRemaining = response.headers.get("x-ratelimit-requests-remaining") || "Unknown";

    return new Response(
      JSON.stringify({
        status: "success",
        date: today,
        quota_remaining: requestsRemaining,
        match_count: filteredMatches.length,
        matches: filteredMatches,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}