-- 188001 fix list items 1, 2, 6 and 11: supply only quotes print one row per line.
-- Only adds a column, nothing is dropped or changed.
ALTER TABLE quotes ADD COLUMN layout text DEFAULT 'auto' NOT NULL;
