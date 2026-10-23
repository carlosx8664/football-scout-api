import { Fragment, useEffect, useState } from "react";
import type { Match } from "../types";
import "./LeagueTable.css";

interface LeagueTableProps {
  match: Match;
}

interface StandingRow {
  position: number;
  name: string;
  shortName: string;
  crest: string;
  played: number;
  points: number;
  highlight: "home" | "away" | null;
}

interface StandingsResponse {
  available: boolean;
  reason?: string;
  rows?: StandingRow[];
  truncatedAbove?: boolean;
  truncatedBelow?: boolean;
}

/** Football seasons start in July, so August 2026 belongs to the 2026/27 season. */
function seasonFor(iso: string): number {
  const date = new Date(iso);
  return date.getUTCMonth() >= 6 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
}

const LeagueTable = ({ match }: LeagueTableProps) => {
  const [state, setState] = useState<{
    fixtureId: number;
    data: StandingsResponse | null;
    error?: string;
  } | null>(null);

  const { fixture, league, teams } = match;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      league: String(league.id),
      home: teams.home.name,
      away: teams.away.name,
      season: String(seasonFor(fixture.date)),
    });

    fetch(`/api/standings?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as StandingsResponse | null;
        if (!response.ok || !body) {
          throw new Error(body?.reason ?? `Table unavailable (HTTP ${response.status})`);
        }
        setState({ fixtureId: fixture.id, data: body });
      })
      .catch((error: Error) => {
        if (error.name === "AbortError") return;
        setState({ fixtureId: fixture.id, data: null, error: error.message });
      });

    return () => controller.abort();
  }, [fixture.id, fixture.date, league.id, teams.home.name, teams.away.name]);

  const current = state?.fixtureId === fixture.id ? state : null;
  const data = current?.data;

  return (
    <section className="league-table-container">
      <h3>📊 {league.name} table</h3>
      <p className="league-table-subtitle">Both teams highlighted</p>

      {!current ? (
        <p className="league-table-note">Loading the table…</p>
      ) : current.error || !data?.available ? (
        <p className="league-table-note">
          {current.error ?? data?.reason ?? "The league table isn't available right now."}
        </p>
      ) : (
        <table className="league-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Team</th>
              <th scope="col">P</th>
              <th scope="col">Pts</th>
            </tr>
          </thead>
          <tbody>
            {data.truncatedAbove ? (
              <tr className="league-table-gap">
                <td colSpan={4}>…</td>
              </tr>
            ) : null}

            {(data.rows ?? []).map((row, index, all) => {
              // Collapse the middle of the table when the two teams are far apart.
              const previous = index > 0 ? all[index - 1] : null;
              const hasGap = previous !== null && row.position > previous.position + 1;

              return (
                <Fragment key={`${row.position}-${row.name}`}>
                  {hasGap ? (
                    <tr className="league-table-gap">
                      <td colSpan={4}>…</td>
                    </tr>
                  ) : null}
                  <tr
                    className={row.highlight ? `league-table-row-${row.highlight}` : undefined}
                  >
                    <td className="league-table-position">{row.position}</td>
                    <td className="league-table-team" title={row.name}>
                      {row.crest ? <img src={row.crest} alt="" /> : null}
                      <span>{row.shortName || row.name}</span>
                    </td>
                    <td className="league-table-stat">{row.played}</td>
                    <td className="league-table-stat league-table-points">{row.points}</td>
                  </tr>
                </Fragment>
              );
            })}

            {data.truncatedBelow ? (
              <tr className="league-table-gap">
                <td colSpan={4}>…</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
    </section>
  );
};

export default LeagueTable;
