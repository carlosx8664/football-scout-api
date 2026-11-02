-- Daily profit is tracked by the day the match kicked off, not the day it was settled:
-- a match kicked off last night that settles this morning belongs to yesterday.
-- Settlement (and cancellation) copies `active_bets.kickoff` into this column.
ALTER TABLE history ADD COLUMN kickoff INTEGER;

CREATE INDEX IF NOT EXISTS history_kickoff_idx ON history (is_simulation, kickoff);
