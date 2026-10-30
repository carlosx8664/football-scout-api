-- Mug bets now live in the same ledger as arbs, so they get Remove / Settle for free.
--
-- `kind` tells the ledger which form created the row:
--   'arb'    - a two-leg arbitrage from the Arbs page (the default, so existing rows are arbs),
--   'muggy'  - a muggy acca: one stake plus an optional cross-bookie hedge,
--   'free'   - a free bet: leg A is a free stake (never debited), leg B is the real hedge.
ALTER TABLE active_bets ADD COLUMN kind TEXT NOT NULL DEFAULT 'arb';

CREATE INDEX IF NOT EXISTS active_bets_kind_idx ON active_bets (is_simulation, kind);
