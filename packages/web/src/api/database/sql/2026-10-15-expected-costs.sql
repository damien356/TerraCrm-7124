-- 188001 fix list item 16: expected costs from the quote, supplier payment terms.
-- Only adds columns, nothing is dropped or changed.
ALTER TABLE suppliers ADD COLUMN terms_days integer;
ALTER TABLE suppliers ADD COLUMN terms_eom integer NOT NULL DEFAULT 1;
ALTER TABLE job_costs ADD COLUMN source text NOT NULL DEFAULT '';
