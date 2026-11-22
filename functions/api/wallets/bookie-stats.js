import {
  DB_UNAVAILABLE_MESSAGE,
  WALLET_CURRENCY,
  dbError,
  getDb,
  json,
  loadLockedByBookie,
  loadWallets,
  modeValue,
  parseSimulation,
  round2,
} from "../../../shared/wallets.js";

/**
 * GET /api/wallets/bookie-stats?simulation=1
 *
 * Per-bookie account health. Every cash movement is already in `wallet_transfers`, so the exact
 * result at a bookie is `balance + withdrawn - deposited`. Settled mug bets explain part of it;
 * whatever is left is what arbs and free bets earned from that bookie once open stakes are added
 * back, because a placed-but-unsettled stake is already out of the balance.
 */
export async function onRequestGet({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const simulation = parseSimulation(new URL(request.url).searchParams.get("simulation"));
  const mode = modeValue(simulation);

  try {
    const [wallets, transfers, muggySettled, muggyOpen, locked] = await Promise.all([
      loadWallets(db, simulation),
      db
        .prepare(
          `SELECT bookie_name AS bookie,
                  COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount ELSE 0 END), 0) AS deposited,
                  COALESCE(SUM(CASE WHEN kind = 'withdrawal' THEN amount ELSE 0 END), 0) AS withdrawn
             FROM wallet_transfers
            WHERE is_simulation = ?
            GROUP BY bookie_name`,
        )
        .bind(mode)
        .all(),
      db
        .prepare(
          `SELECT CASE WHEN COALESCE(bookie_a_stake, 0) > 0 THEN bookie_a_name ELSE bookie_b_name END
                    AS bookie,
                  COUNT(*) AS bets,
                  COALESCE(SUM(CASE WHEN settlement_type <> 'cancelled'
                                    THEN COALESCE(bookie_a_stake, 0) + COALESCE(bookie_b_stake, 0)
                                    ELSE 0 END), 0) AS staked,
                  COALESCE(SUM(net_profit), 0) AS pnl
             FROM history
            WHERE is_simulation = ? AND kind = 'muggy'
            GROUP BY bookie`,
        )
        .bind(mode)
        .all(),
      db
        .prepare(
          `SELECT CASE WHEN COALESCE(bookie_a_stake, 0) > 0 THEN bookie_a_name ELSE bookie_b_name END
                    AS bookie,
                  COUNT(*) AS bets,
                  COALESCE(SUM(COALESCE(bookie_a_stake, 0) + COALESCE(bookie_b_stake, 0)), 0) AS staked
             FROM active_bets
            WHERE is_simulation = ? AND kind = 'muggy'
            GROUP BY bookie`,
        )
        .bind(mode)
        .all(),
      loadLockedByBookie(db, simulation),
    ]);

    const cash = new Map((transfers.results ?? []).map((row) => [String(row.bookie), row]));
    const settled = new Map((muggySettled.results ?? []).map((row) => [String(row.bookie), row]));
    const open = new Map((muggyOpen.results ?? []).map((row) => [String(row.bookie), row]));
    const inPlay = new Map(locked.map((row) => [row.bookie, row.locked]));

    const bookies = wallets.map((wallet) => {
      const cashRow = cash.get(wallet.name);
      const settledRow = settled.get(wallet.name);
      const openRow = open.get(wallet.name);

      const deposited = round2(Number(cashRow?.deposited ?? 0));
      const withdrawn = round2(Number(cashRow?.withdrawn ?? 0));
      const muggyPnl = round2(Number(settledRow?.pnl ?? 0));
      const openStaked = round2(Number(inPlay.get(wallet.name) ?? 0));
      // Exact, because the balance only ever moves through logged transfers and bets. Open stakes
      // are added back, so this reads as a settled result rather than dipping while a bet runs.
      const accountPnl = round2(wallet.balance + openStaked + withdrawn - deposited);

      return {
        bookie: wallet.name,
        balance: wallet.balance,
        deposited,
        withdrawn,
        netFunding: round2(deposited - withdrawn),
        muggyBets: Number(settledRow?.bets ?? 0) + Number(openRow?.bets ?? 0),
        muggyStaked: round2(Number(settledRow?.staked ?? 0) + Number(openRow?.staked ?? 0)),
        muggyPnl,
        /** Settled arb/free result: the account result minus the mug-bet part. */
        arbPnl: round2(accountPnl - muggyPnl),
        accountPnl,
        openStaked,
      };
    });

    const active = bookies.filter(
      (row) =>
        row.deposited > 0 ||
        row.withdrawn > 0 ||
        row.muggyBets > 0 ||
        row.openStaked > 0 ||
        Math.abs(row.balance) > 0.005 ||
        Math.abs(row.accountPnl) > 0.005,
    );

    const totals = active.reduce(
      (sum, row) => ({
        balance: round2(sum.balance + row.balance),
        deposited: round2(sum.deposited + row.deposited),
        withdrawn: round2(sum.withdrawn + row.withdrawn),
        muggyBets: sum.muggyBets + row.muggyBets,
        muggyStaked: round2(sum.muggyStaked + row.muggyStaked),
        muggyPnl: round2(sum.muggyPnl + row.muggyPnl),
        arbPnl: round2(sum.arbPnl + row.arbPnl),
        accountPnl: round2(sum.accountPnl + row.accountPnl),
        openStaked: round2(sum.openStaked + row.openStaked),
      }),
      {
        balance: 0,
        deposited: 0,
        withdrawn: 0,
        muggyBets: 0,
        muggyStaked: 0,
        muggyPnl: 0,
        arbPnl: 0,
        accountPnl: 0,
        openStaked: 0,
      },
    );

    active.sort((a, b) => b.deposited - a.deposited || a.bookie.localeCompare(b.bookie));

    return json({ simulation, currency: WALLET_CURRENCY, bookies: active, totals });
  } catch (error) {
    return dbError(error);
  }
}
