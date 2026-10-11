-- Fix list 11 Oct, items 2 and 3: whole lengths, rolls and underlay.
-- Applied by script after a full backup, never through db:push.
--
-- 1. products.roll_length_m: metres on one roll (underlay, plastic, Floorshield).
-- 2. products.piece_length_m: the length a trim comes in (2.4 m).
-- 3. products.default_wastage_pct: the supplier file's wastage %, wins over Settings.
-- 4. quote_items.follows_item_id: on an underlay line, the floor line it follows.
-- 5. Underlay splits into carpet_underlay and hard_floor_underlay. Damien
--    (answers 11 Oct, item 10): the 12 underlays on file go to hard floor
--    underlay. None of them is on a quote line.

ALTER TABLE products ADD COLUMN roll_length_m real;
ALTER TABLE products ADD COLUMN piece_length_m real;
ALTER TABLE products ADD COLUMN default_wastage_pct real;
ALTER TABLE quote_items ADD COLUMN follows_item_id integer;

UPDATE products SET category = 'hard_floor_underlay' WHERE category = 'underlay';
