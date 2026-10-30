-- Mug bets gate arbs: one muggy acca per day must be logged before any arb is placed.
-- `kind` lets the check see mug bets that have already settled into history.
ALTER TABLE history ADD COLUMN kind TEXT;
