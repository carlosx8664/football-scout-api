import { useEffect, useState } from "react";
import type { Match } from "../types";
import { Link } from "react-router-dom";
import { formatKickoff, matchWinnerPrices } from "../lib/format";
import BookBreakdown from "./BookBreakdown";
import "./MatchDetail.css";

interface MatchDetailProps {
  match: Match | null;
  date: string;
}

const MatchDetail = ({ match, date }: MatchDetailProps) => {
  // Set only after the request settles, so the effect never writes state synchronously.
  const [request, setRequest] = useState<{
    fixtureId: number;
    text: string | null;
    status: "ready" | "error";
    error?: string;
  } | null>(null);

  // Analyses baked into the feed win; otherwise ask the Pages Function, which calls DeepSeek
  // server-side and caches the result in KV.
  useEffect(() => {
    if (!match || match.ai_analysis) return;

    const controller = new AbortController();
    const prices = ["Home", "Draw", "Away"]
      .map((label) => match.odds?.find((entry) => entry.value === label)?.odd)
      .filter(Boolean)
      .join(" / ");

    const params = new URLSearchParams({
      id: String(match.fixture.id),
      home: match.teams.home.name,
      away: match.teams.away.name,
      league: match.league.name,
      kickoff: match.fixture.date,
      odds: prices,
    });

    fetch(`/api/analysis?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { analysis?: string; error?: string }
          | null;
        if (!response.ok || !body?.analysis) {
          throw new Error(body?.error ?? `Analysis unavailable (HTTP ${response.status})`);
        }
        setRequest({ fixtureId: match.fixture.id, text: body.analysis, status: "ready" });
      })
      .catch((error: Error) => {
        if (error.name === "AbortError") return;
        console.warn("Scout analysis failed:", error.message);
        setRequest({
          fixtureId: match.fixture.id,
          text: null,
          status: "error",
          error: error.message,
        });
      });

    return () => controller.abort();
  }, [match]);

  if (!match) {
    return (
      <main className="detail-container">
        <Link className="back-link" to="/">
          ← Back to matches
        </Link>
        <div className="empty-state">That match is not on today's slate ({date}).</div>
      </main>
    );
  }

  const kickoff = formatKickoff(match.fixture.date);
  const prices = matchWinnerPrices(match.odds);
  const hasScore = match.goals?.home != null && match.goals?.away != null;

  const resolved = request?.fixtureId === match.fixture.id ? request : null;
  const analysis = match.ai_analysis ?? resolved?.text ?? null;
  const analysisStatus = match.ai_analysis ? "ready" : (resolved?.status ?? "loading");

  return (
    <main className="detail-container">
      <Link className="back-link" to="/">
        ← Back to matches
      </Link>

      <article className="detail-card">
        <div className="detail-meta">
          <span>{match.league.name}</span>
          <span>
            {kickoff.date} · {kickoff.time}
          </span>
        </div>

        <div className="detail-teams">
          <div className="detail-team">
            {match.teams.home.logo && <img src={match.teams.home.logo} alt="" />}
            <span>{match.teams.home.name}</span>
          </div>
          <span className="detail-score">
            {hasScore ? `${match.goals?.home} - ${match.goals?.away}` : "vs"}
          </span>
          <div className="detail-team">
            {match.teams.away.logo && <img src={match.teams.away.logo} alt="" />}
            <span>{match.teams.away.name}</span>
          </div>
        </div>

        <div className="detail-odds">
          <div className="odd-box">
            <span className="odd-label">1</span>
            <span className="odd-value">{prices.home}</span>
            <BookBreakdown price={match.book_odds?.home} />
          </div>
          <div className="odd-box">
            <span className="odd-label">X</span>
            <span className="odd-value">{prices.draw}</span>
            <BookBreakdown price={match.book_odds?.draw} />
          </div>
          <div className="odd-box">
            <span className="odd-label">2</span>
            <span className="odd-value">{prices.away}</span>
            <BookBreakdown price={match.book_odds?.away} />
          </div>
        </div>

        <section className="ai-box">
          <strong>🤖 Scout Analysis</strong>
          <p>
            {analysisStatus === "loading" ? (
              "Reading the market and writing up a view…"
            ) : analysis ? (
              analysis
            ) : (
              <>
                Couldn't pull a write-up for this one. Refresh to try again, and check the team
                news yourself before you back it.
                {resolved?.error ? (
                  <span className="ai-error-detail"> Reason: {resolved.error}</span>
                ) : null}
              </>
            )}
          </p>
        </section>
      </article>
    </main>
  );
};

export default MatchDetail;
