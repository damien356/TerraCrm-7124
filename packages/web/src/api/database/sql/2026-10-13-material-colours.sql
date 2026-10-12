-- Fix list 11 Oct, items 8 and 10: the material selection form checks the colours on the accepted quote.
-- Only adds columns, nothing is dropped or changed. No FKs on purpose.
ALTER TABLE products ADD COLUMN swatch_key text;
ALTER TABLE material_selections ADD COLUMN notes text DEFAULT '' NOT NULL;
ALTER TABLE material_selections ADD COLUMN variation_id integer;
ALTER TABLE material_selections ADD COLUMN task_id integer;
ALTER TABLE material_selection_items ADD COLUMN quote_item_id integer;
ALTER TABLE material_selection_items ADD COLUMN quoted_product_id integer;
ALTER TABLE material_selection_items ADD COLUMN product_id integer;
ALTER TABLE material_selection_items ADD COLUMN qty real;
ALTER TABLE material_selection_items ADD COLUMN unit text;
ALTER TABLE material_selection_items ADD COLUMN extra_ex_gst real;
ALTER TABLE material_selection_items ADD COLUMN material_ids text DEFAULT '[]' NOT NULL;
ALTER TABLE material_selection_items ADD COLUMN variation_id integer;
ALTER TABLE material_selection_items ADD COLUMN variation_item_id integer;
