-- Copy from previous job (16 Oct). Four new columns. Nothing existing is changed.
ALTER TABLE products ADD COLUMN site_prep integer DEFAULT 0 NOT NULL;
ALTER TABLE labour_rate_items ADD COLUMN site_prep integer DEFAULT 0 NOT NULL;
ALTER TABLE quotes ADD COLUMN copied_from_quote_id integer;
ALTER TABLE quote_items ADD COLUMN check_required integer DEFAULT 0 NOT NULL;
