/**
 * Wallet + simulation-mode data access shared by the `/api/wallets` Functions.
 *
 * Every statement filters on `is_simulation`, so flipping the global mode toggle can never read
 * or write the other mode's rows.
 */

import { BOOKMAKERS } from "./deeplinks.js";

export const DB_BINDING = "DB";
export const WALLET_CURRENCY = "GHS";
/** "Reset Simulation Wallets to 1,000 GHS" across the four wallets. */
export const SIMULATION_RESET_PER_WALLET = 250;

/* ------------------------------------------------------------------ *
 * Human-looking cash movements
 * ------------------------------------------------------------------ */

/** Deposits/withdrawals are snapped to round numbers in this range — never odd cents. */
export const TRANSFER_STEP = 50;
export const MIN_TRANSFER = 50;
export const MAX_TRANSFER = 500;
/** One movement per bookie per mode in this window, so bursts never look automated. */
export const TRANSFER_COOLDOWN_MS = 10 * 60 * 1000;

/** A bet placed inside this window keeps its bookies out of the rebalancing hints. */
export const PENDING_SETTLEMENT_HOURS = 4;

/**
 * Bookies with an unsettled bet placed in the last few hours. Their cash looks low only because
 * the stake is in play, so rebalancing advice for them would be wrong until it settles.
 */
export async function loadPendingSettlement(db, simulation) {
  const mode = modeValue(simulation);

  const { results } = await db
    .prepare(
      `SELECT bookie_a_name AS bookie FROM active_bets
        WHERE is_simulation = ? AND datetime(created_at) >= datetime('now', ?)
       UNION
       SELECT bookie_b_name AS bookie FROM active_bets
        WHERE is_simulation = ? AND datetime(created_at) >= datetime('now', ?)`,
    )
    .bind(mode, `-${PENDING_SETTLEMENT_HOURS} hours`, mode, `-${PENDING_SETTLEMENT_HOURS} hours`)
    .all();

  return (results ?? []).map((row) => row.bookie).filter(Boolean);
}

/** Snaps a raw requirement to a believable transfer size, or null when nothing sensible fits. */
export function suggestTransfer(kind, needed) {
  const value = Number(needed);
  if (!Number.isFinite(value) || value <= 0) return null;

  const rounded =
    kind === "withdrawal"
      ? Math.floor(value / TRANSFER_STEP) * TRANSFER_STEP
      : Math.ceil(value / TRANSFER_STEP) * TRANSFER_STEP;

  const clamped = Math.min(MAX_TRANSFER, Math.max(MIN_TRANSFER, rounded));
  return clamped >= MIN_TRANSFER ? clamped : null;
}

export const DB_UNAVAILABLE_MESSAGE =
  `D1 binding "${DB_BINDING}" is not configured. Add a d1_databases entry to wrangler.jsonc and run ` +
  `\`npx wrangler d1 migrations apply ${DB_BINDING} --local\`.`;

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Turns any query failure into a JSON error without leaking raw SQLite text to the UI. */
export function dbError(error) {
  const message = error instanceof Error ? error.message : String(error);

  // Schema drift (an unapplied migration) is the common case and deserves plain language.
  if (/no such (table|column)|has no column/i.test(message)) {
    return json(
      {
        error:
          "The ledger database is missing a recent update. Apply migrations with " +
          "`npm run db:migrate:local` (dev) or `npm run db:migrate` (production), then reload.",
      },
      503,
    );
  }

  return json({ error: `Could not read the ledger. Please try again. (${message})` }, 500);
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

/**
 * Creates a wallet row for every bookmaker the scanner supports, so adding a bookie to
 * `BOOKMAKERS` (shared/deeplinks.js) automatically surfaces it on the wallets page. Existing
 * balances are never touched — INSERT OR IGNORE rides on the (bookie_name, is_simulation) index.
 */
export async function ensureWallets(db, simulation) {
  const mode = modeValue(simulation);
  const prefix = simulation ? "sim" : "real";

  const statements = BOOKMAKERS.map((bookie) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO wallets (id, bookie_name, balance, is_simulation)
         VALUES (?, ?, 0, ?)`,
      )
      .bind(
        `${prefix}-${bookie.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
        bookie,
        mode,
      ),
  );

  if (statements.length > 0) await db.batch(statements);
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
  await ensureWallets(db, simulation);

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

/**
 * Cash that is not in a bookie account — the mobile-money wallet. Seeded by "Start afresh" with
 * the leftover from rounding opening deposits down, and topped up by weekly cash-outs.
 */
export async function loadCashReserve(db, simulation) {
  const row = await db
    .prepare("SELECT balance FROM cash_reserve WHERE is_simulation = ?")
    .bind(modeValue(simulation))
    .first();

  return round2(Number(row?.balance ?? 0));
}

/** Overwrites the reserve for one mode and returns the stored value. */
export async function setCashReserve(db, simulation, balance) {
  const value = Math.max(0, round2(Number(balance) || 0));

  await db
    .prepare(
      `INSERT INTO cash_reserve (is_simulation, balance, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (is_simulation) DO UPDATE SET
         balance = excluded.balance,
         updated_at = excluded.updated_at`,
    )
    .bind(modeValue(simulation), value)
    .run();

  return value;
}

/** Response body shared by GET /api/wallets, PATCH /api/wallets/:id and POST /api/wallets/reset. */
export async function walletPayload(db, simulation) {  const mode = modeValue(simulation);

  const [wallets, liquidity, history, transfers, pending, cashReserve] = await Promise.all([
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
    db
      .prepare(
        `SELECT
           COUNT(*) AS count,
           COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount ELSE 0 END), 0) AS deposited,
           COALESCE(SUM(CASE WHEN kind = 'withdrawal' THEN amount ELSE 0 END), 0) AS withdrawn,
           COUNT(DISTINCT bookie_name) AS bookies
         FROM wallet_transfers WHERE is_simulation = ?`,
      )
      .bind(mode)
      .first(),
    loadPendingSettlement(db, simulation),
    loadCashReserve(db, simulation),
  ]);

  return {
    simulation,
    currency: WALLET_CURRENCY,
    wallets,
    liquidity,
    /** Mobile-money wallet: bankroll that is not sitting in a bookie account. */
    cashReserve,
    totalProfit: round2(Number(history?.total_profit ?? 0)),
    /** Realised profit settled today (UTC) — drives the "take a break" alert. */
    dailyProfit: round2(Number(history?.daily_profit ?? 0)),
    cashFlow: {
      count: Number(transfers?.count ?? 0),
      deposited: round2(Number(transfers?.deposited ?? 0)),
      withdrawn: round2(Number(transfers?.withdrawn ?? 0)),
      net: round2(Number(transfers?.deposited ?? 0) - Number(transfers?.withdrawn ?? 0)),
      bookies: Number(transfers?.bookies ?? 0),
    },
    /** Bookies whose cash is in play right now — rebalancing ignores them until it settles. */
    pendingSettlement: {
      windowHours: PENDING_SETTLEMENT_HOURS,
      bookies: pending,
    },
  };
}
