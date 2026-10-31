-- The daily mug-bet gate must judge a mug bet by the day it was *logged*, not the day it settled:
-- an acca placed last night that settles this morning is yesterday's camouflage, not today's.
-- Settlement copies `active_bets.created_at` into this column.
ALTER TABLE history ADD COLUMN logged_at TEXT;

CREATE INDEX IF NOT EXISTS history_logged_at_idx ON history (is_simulation, kind, logged_at);
