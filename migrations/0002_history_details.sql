-- History rows keep enough detail to render the ledger without the original active_bets row.
-- Nullable so rows settled before this migration still read back (they simply show "—").
ALTER TABLE history ADD COLUMN bookie_a_name TEXT;
ALTER TABLE history ADD COLUMN bookie_a_stake REAL;
ALTER TABLE history ADD COLUMN bookie_b_name TEXT;
ALTER TABLE history ADD COLUMN bookie_b_stake REAL;
ALTER TABLE history ADD COLUMN total_stake REAL;
