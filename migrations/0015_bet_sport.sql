-- Which sport a ledger row came from, so horse-racing mug bets can be told apart from football.
-- Existing rows are football, which is what every row logged before this migration was.
ALTER TABLE active_bets
  ADD COLUMN sport TEXT NOT NULL DEFAULT 'football'
  CHECK (sport IN ('football', 'horse-racing'));

ALTER TABLE history
  ADD COLUMN sport TEXT NOT NULL DEFAULT 'football'
  CHECK (sport IN ('football', 'horse-racing'));
