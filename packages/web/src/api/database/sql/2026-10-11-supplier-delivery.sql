-- Fix list 11 Oct, item 14: supplier delivery rules on purchase orders.
-- Applied by script after a full backup, never through db:push.
--
-- 1. suppliers.delivers_to: warehouse, site or both. Default both.
--    EC Carpets (15) delivers to the warehouse only.
-- 2. supplier_fee_rules.applies_to: warehouse, site or both. Default both.
--    Hurford's crane truck (766) is site only. Every other fee goes on both,
--    so a warehouse order now carries the supplier's delivery fee (EC $69.90,
--    Terramater $100 and the rest) instead of dropping it.

ALTER TABLE suppliers ADD COLUMN delivers_to text NOT NULL DEFAULT 'both';
ALTER TABLE supplier_fee_rules ADD COLUMN applies_to text NOT NULL DEFAULT 'both';

UPDATE suppliers SET delivers_to = 'warehouse' WHERE id = 15 AND name = 'EC Carpets';
UPDATE supplier_fee_rules SET applies_to = 'site' WHERE id = 766 AND supplier_id = 10;
