import { useEffect, useState } from "react";
import { fetchBookieStats } from "../lib/bookieStats";
import { formatAmount } from "../lib/wallets";
import type { BookieStat, BookieStatsPayload } from "../types";
import "./BookieHealthPanel.css";

interface BookieHealthPanelProps {
  simulation: boolean;
  /** Bumped after any ledger write so a settled bet or mug stake is reflected here. */
  refreshToken: number;
}

type StatValues = Pick<
  BookieStat,
  | "balance"
  | "openStaked"
  | "deposited"
  | "withdrawn"
  | "muggyBets"
  | "muggyStaked"
  | "muggyPnl"
  | "arbPnl"
  | "accountPnl"
>;

const signed = (amount: number) =>
  `${amount >= 0 ? "+" : "−"}${formatAmount(Math.abs(amount))}`;

const pnlClass = (amount: number) =>
  `bookie-health-pnl${amount < 0 ? " negative" : amount > 0 ? " positive" : ""}`;

/** How much of the arb profit the mug bets have given back; null when there is no arb profit. */
const mugCover = (row: StatValues) =>
  row.arbPnl > 0 ? (Math.max(0, -row.muggyPnl) / row.arbPnl) * 100 : null;

const coverClass = (cover: number | null) =>
  cover === null ? " none" : cover < 15 ? " low" : cover <= 35 ? " good" : " high";

const coverLabel = (cover: number | null) => (cover === null ? "—" : `${Math.round(cover)}%`);

/** One row's cells, reused by the body and the totals footer. */
const StatCells = ({ row }: { row: StatValues }) => {
  const cover = mugCover(row);

  return (
    <>
      <td className="bookie-health-money">
        {formatAmount(row.balance)}
        {row.openStaked > 0 && (
          <span className="bookie-health-sub">{formatAmount(row.openStaked)} in play</span>
        )}
      </td>
      <td className="bookie-health-money">{formatAmount(row.deposited)}</td>
      <td className="bookie-health-money">{formatAmount(row.withdrawn)}</td>
      <td className="bookie-health-money">{row.muggyBets}</td>
      <td className={`bookie-health-cover${coverClass(cover)}`} title="Mug cost ÷ arb profit">
        {coverLabel(cover)}
      </td>
      <td className={pnlClass(row.muggyPnl)}>{signed(row.muggyPnl)}</td>
      <td className={pnlClass(row.arbPnl)}>{signed(row.arbPnl)}</td>
      <td className={pnlClass(row.accountPnl)}>{signed(row.accountPnl)}</td>
    </>
  );
};

/**
 * Per-bookie health: what has gone in and out of each account, what the mug bets cost there, and
 * what arbitrage has earned from it — the picture the bookmaker sees of this punter.
 */
const BookieHealthPanel = ({ simulation, refreshToken }: BookieHealthPanelProps) => {
  const key = simulation ? "sim" : "real";
  const [result, setResult] = useState<{ key: string; payload: BookieStatsPayload } | null>(null);
  const [problem, setProblem] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchBookieStats(simulation, controller.signal)
      .then((next) => {
        setResult({ key, payload: next });
        setProblem(null);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setProblem({ key, message: err.message });
      });

    return () => controller.abort();
  }, [simulation, refreshToken, key]);

  const payload = result?.key === key ? result.payload : null;
  const error = problem?.key === key ? problem.message : null;
  const loading = payload === null && error === null;
  const rows = payload?.bookies ?? [];

  return (
    <section className="bookie-health">
      <header className="bookie-health-header">
        <div>
          <h2>Bookie Health</h2>
          <p className="bookie-health-subtitle">
            How each {simulation ? "simulation" : "real"} account looks to the bookie — settled
            Account P/L excludes stakes still in play.
          </p>
        </div>
        <span className="bookie-health-count">
          {rows.length} {rows.length === 1 ? "bookie" : "bookies"}
        </span>
      </header>

      {error && <p className="bookie-health-error">{error}</p>}

      {loading ? (
        <p className="bookie-health-empty">Loading bookie stats…</p>
      ) : !payload ? null : rows.length === 0 ? (
        <p className="bookie-health-empty">
          No bookie activity yet. Fund a wallet or log a bet to see its health here.
        </p>
      ) : (
        <div className="bookie-health-table-wrap">
          <table className="bookie-health-table">
            <thead>
              <tr>
                <th scope="col">Bookie</th>
                <th scope="col">Balance</th>
                <th scope="col">Deposited</th>
                <th scope="col">Withdrawn</th>
                <th scope="col">Mug bets</th>
                <th scope="col">Mug cover</th>
                <th scope="col">Muggy P/L</th>
                <th scope="col">Arb P/L</th>
                <th scope="col">Account P/L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.bookie}>
                  <th scope="row" className="bookie-health-name">
                    {row.bookie}
                  </th>
                  <StatCells row={row} />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">All bookies</th>
                <StatCells row={payload.totals} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="bookie-health-hint">
        <strong>Mug cover</strong> is the mug cost as a share of arb profit — aim for 20–35%. Under
        15% looks sharp to a bookie; over 35% is more camouflage than you need.
      </p>
    </section>
  );
};

export default BookieHealthPanel;
