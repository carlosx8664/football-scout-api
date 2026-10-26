-- Void / cash-out settlements need their own tag so History can badge them and colour the
-- net profit differently. Existing rows are ordinary wins.
ALTER TABLE history ADD COLUMN settlement_type TEXT NOT NULL DEFAULT 'win';
