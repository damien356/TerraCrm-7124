-- Supply only quotes: pickup or delivery, set on the Send screen (Damien, 17 Nov 2026).
--
-- pickup or delivery. Null, the start for every quote, means the wording is
-- worked out from the quote lines, then the job's purchase order.
--
-- Additive: one new nullable column. Nothing else changes. Fails harmlessly
-- with "duplicate column name" if it has run.
ALTER TABLE `quotes` ADD `fulfilment` text;
