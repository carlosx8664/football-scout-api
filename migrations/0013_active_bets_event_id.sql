-- Sportradar fixture id so live scores can be matched back to a logged bet.
-- The live-scores Worker reads this to decide which matches to poll for a final result.
ALTER TABLE active_bets ADD COLUMN sr_event_id TEXT;

CREATE INDEX IF NOT EXISTS active_bets_event_idx ON active_bets (sr_event_id);
