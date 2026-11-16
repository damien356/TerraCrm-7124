-- Supplier charges on the client copy (Damien, 16 Nov 2026, Q188104).
--
-- combined: freight, baling and levies are spread into that supplier's
-- product lines, as today (notes 18.33). lines: on the itemised layout each
-- charge prints as its own row. The sections layout always combines.
--
-- Additive: one new column that starts at 'combined', so every quote reads
-- the same as before. Fails harmlessly with "duplicate column name" if it has run.
ALTER TABLE `quotes` ADD `charges_on_copy` text DEFAULT 'combined' NOT NULL;
