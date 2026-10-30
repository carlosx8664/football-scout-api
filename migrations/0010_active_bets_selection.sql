-- The ledger shows which side each bookie holds (e.g. "Over 6.5" vs "Under 6.5"), so the
-- selection label from the arb feed is stored per leg. Rows logged before this are null.
ALTER TABLE active_bets ADD COLUMN bookie_a_selection TEXT;
ALTER TABLE active_bets ADD COLUMN bookie_b_selection TEXT;
