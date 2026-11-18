-- A fixed $ deposit on one quote, in place of the % (Damien, 18 Nov 2026).
--
-- GST inclusive dollars, for that quote only. Null, the start for every
-- quote, means the deposit is the %. Cards and payment terms stay % only.
--
-- Additive: one new nullable column. Nothing else changes. Fails harmlessly
-- with "duplicate column name" if it has run.
-- Applied live 18 Nov 2026 with Damien's OK, after a backup.
ALTER TABLE `quotes` ADD `deposit_fixed` real;
