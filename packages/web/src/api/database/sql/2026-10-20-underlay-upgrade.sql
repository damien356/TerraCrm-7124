-- Fix list 11 Oct, item 9: the underlay upgrade offer on the material selection form.
-- Two new columns on material_selection_items. Nothing existing is changed.
ALTER TABLE material_selection_items ADD COLUMN offer_product_id integer;
ALTER TABLE material_selection_items ADD COLUMN answer text DEFAULT '' NOT NULL;
