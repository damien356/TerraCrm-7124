-- Items 8 and 9: auto install labour, measured m2 plus wastage (10 Oct 2026).
-- Applied by script after a full backup, never through db:push.
--
-- 1. products.sold_as: box or broadloom. Tagged by the same rule as
--    autoSoldAs() in api/lib/flooring-qty.ts. Rows it does not cover stay null.
-- 2. Five new columns on quote_items. All nullable, nothing to backfill:
--    live had 0 quote lines when this was written.
-- 3. Wastage % per floor type lives in settings (wastage_pct_<type>).
--    No rows are written: a missing key reads as 0%.

ALTER TABLE products ADD COLUMN sold_as text;

ALTER TABLE quote_items ADD COLUMN measured_m2 real;
ALTER TABLE quote_items ADD COLUMN wastage_pct real;
ALTER TABLE quote_items ADD COLUMN roll_width_m real;
ALTER TABLE quote_items ADD COLUMN labour_for_item_id integer;
ALTER TABLE quote_items ADD COLUMN rate_item_id integer;

UPDATE products SET sold_as = 'broadloom' WHERE category IN ('carpet', 'turf');
UPDATE products SET sold_as = 'box' WHERE category IN ('carpet_tile', 'hybrid', 'laminate') AND unit = 'm2';
UPDATE products SET sold_as = 'box' WHERE category = 'timber' AND unit = 'm2';
-- Vinyl: box size on file means planks or tiles (some Armstrong and MJS rows
-- also carry the box m2 in roll_m2, so box wins). A roll width or roll size
-- with no box means sheet. Neither means LVT planks with no box size yet.
UPDATE products SET sold_as = 'box'
  WHERE category = 'vinyl' AND (units_per_pack IS NOT NULL OR pack_m2_printed IS NOT NULL);
UPDATE products SET sold_as = 'broadloom'
  WHERE category = 'vinyl' AND sold_as IS NULL AND (width_m IS NOT NULL OR roll_m2 IS NOT NULL);
UPDATE products SET sold_as = 'box' WHERE category = 'vinyl' AND sold_as IS NULL;
