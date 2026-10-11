-- Fix list 11 Oct, item 12: variations priced like a quote, sent and signed online (/v/<token>).
-- The variations table is on live with no rows. These add to it, nothing is dropped.
ALTER TABLE variations ADD COLUMN quote_id integer REFERENCES quotes(id) ON DELETE set null;
ALTER TABLE variations ADD COLUMN token text;
ALTER TABLE variations ADD COLUMN views integer DEFAULT 0 NOT NULL;
ALTER TABLE variations ADD COLUMN first_viewed_at integer;
ALTER TABLE variations ADD COLUMN last_viewed_at integer;
ALTER TABLE variations ADD COLUMN subtotal real DEFAULT 0 NOT NULL;
ALTER TABLE variations ADD COLUMN gst real DEFAULT 0 NOT NULL;
ALTER TABLE variations ADD COLUMN total real DEFAULT 0 NOT NULL;
ALTER TABLE variations ADD COLUMN bill_mode text DEFAULT 'final' NOT NULL;
ALTER TABLE variations ADD COLUMN invoice_id integer REFERENCES invoices(id) ON DELETE set null;
ALTER TABLE variations ADD COLUMN photo_media_ids text DEFAULT '[]' NOT NULL;
ALTER TABLE variations ADD COLUMN sent_at integer;
ALTER TABLE variations ADD COLUMN rejected_at integer;
ALTER TABLE variations ADD COLUMN work_made_at integer;
CREATE UNIQUE INDEX IF NOT EXISTS variations_token_unique ON variations (token);
CREATE TABLE IF NOT EXISTS variation_items (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  variation_id integer NOT NULL REFERENCES variations(id) ON DELETE cascade,
  product_id integer REFERENCES products(id) ON DELETE set null,
  rate_item_id integer REFERENCES labour_rate_items(id) ON DELETE set null,
  kind text DEFAULT 'supply' NOT NULL,
  line_type text DEFAULT 'material' NOT NULL,
  description text NOT NULL,
  qty real DEFAULT 1 NOT NULL,
  unit text DEFAULT 'm2' NOT NULL,
  unit_price real DEFAULT 0 NOT NULL,
  unit_cost real,
  total real DEFAULT 0 NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS variation_items_variation_idx ON variation_items (variation_id);
CREATE TABLE IF NOT EXISTS variation_signatures (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  variation_id integer NOT NULL REFERENCES variations(id) ON DELETE cascade,
  name text NOT NULL,
  position text DEFAULT '' NOT NULL,
  email text,
  signature_json text NOT NULL,
  terms_version text DEFAULT '' NOT NULL,
  signed_at integer NOT NULL,
  ip text,
  user_agent text,
  pdf_key text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS variation_signatures_variation_idx ON variation_signatures (variation_id);
