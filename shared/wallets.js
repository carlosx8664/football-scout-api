/**
 * Wallet + simulation-mode data access shared by the `/api/wallets` Functions.
 *
 * Every statement filters on `is_simulation`, so flipping the global mode toggle can never read
 * or write the other mode's rows.
 */

export const DB_BINDING = "DB";
export const WALLET_CURRENCY = "GHS";
/** "Reset Simulation Wallets to 1,000 GHS" across the four wallets. */
export const SIMULATION_RESET_PER_WALLET = 250;

export const DB_UNAVAILABLE_MESSAGE =
  `D1 binding "${DB_BINDING}" is not configured. Add a d1_databases entry to wrangler.jsonc and run ` +
  `\`npx wrangler d1 migrations apply ${DB_BINDING} --local\`.`;

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Turns any query failure into a JSON error, hinting at migrations for missing schema. */
export function dbError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const hint = /no such (table|column)|has no column/i.test(message)
    ? " Apply the latest migrations: `npm run db:migrate:local` (dev) or `npm run db:migrate` (production)."
    : "";

  return json({ error: `Database query failed: ${message}.${hint}` }, 500);
}

/** Returns the D1 binding, or null so handlers can answer 503 instead of throwing. */
export function getDb(env) {
  const db = env?.[DB_BINDING];
  return db && typeof db.prepare === "function" ? db : null;
}

/** Missing or unknown values fall back to simulation, matching the UI default. */
export function parseSimulation(value, fallback = true) {
  if (value === null || value === undefined || value === "") return fallback;

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "sim", "simulation"].includes(normalized)) return true;
  if (["0", "false", "real", "live"].includes(normalized)) return false;

  return fallback;
}

export function modeValue(simulation) {
  return simulation ? 1 : 0;
}

export function round2(value) {
  return Math.round(value * 100) / 100;
}

function toWallet(row) {
  return {
    id: row.id,
    name: row.bookie_name,
    bookmaker: row.bookie_name,
    balance: round2(Number(row.balance ?? 0)),
    currency: WALLET_CURRENCY,
    isSimulation: row.is_simulation === 1,
    updatedAt: null,
  };
}

export async function loadWallets(db, simulation) {
  const { results } = await db
    .prepare(
      `SELECT id, bookie_name, balance, is_simulation
         FROM wallets
        WHERE is_simulation = ?
        ORDER BY bookie_name COLLATE NOCASE ASC`,
    )
    .bind(modeValue(simulation))
    .all();

  return (results ?? []).map(toWallet);
}

/**
 * Cash on hand per mode.
 *
 * Stakes are debited from the wallets the moment a bet is logged, so every balance is already
 * spendable — `available` is simply the wallet total. `staked` is reported alongside it as the
 * amount still at risk in unsettled bets.
 */
export async function loadLiquidity(db, simulation) {
  const mode = modeValue(simulation);

  const row = await db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(balance), 0) FROM wallets WHERE is_simulation = ?) AS total_balance,
         (SELECT COALESCE(SUM(bookie_a_stake + bookie_b_stake), 0) FROM active_bets
           WHERE is_simulation = ?) AS staked`,
    )
    .bind(mode, mode)
    .first();

  const totalBalance = round2(Number(row?.total_balance ?? 0));
  const staked = round2(Number(row?.staked ?? 0));

  return {
    currency: WALLET_CURRENCY,
    totalBalance,
    staked,
    available: totalBalance,
  };
}

/** Response body shared by GET /api/wallets, PATCH /api/wallets/:id and POST /api/wallets/reset. */
export async function walletPayload(db, simulation) {
  const mode = modeValue(simulation);

  const [wallets, liquidity, history] = await Promise.all([
    loadWallets(db, simulation),
    loadLiquidity(db, simulation),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(net_profit), 0) AS total_profit,
           COALESCE(SUM(CASE WHEN date(settled_at) = date('now') THEN net_profit ELSE 0 END), 0)
             AS daily_profit
           FROM history WHERE is_simulation = ?`,
      )
      .bind(mode)
      .first(),
  ]);

  return {
    simulation,
    currency: WALLET_CURRENCY,
    wallets,
    liquidity,
    totalProfit: round2(Number(history?.total_profit ?? 0)),
    /** Realised profit settled today (UTC) — drives the "take a break" alert. */
    dailyProfit: round2(Number(history?.daily_profit ?? 0)),
  };
}
