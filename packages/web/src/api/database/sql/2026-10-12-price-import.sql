-- Fix list 11 Oct, item 4: price list import and export (Settings, Price list).
ALTER TABLE products ADD COLUMN roll_price real;
CREATE TABLE IF NOT EXISTS price_imports (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  file_name text DEFAULT '' NOT NULL,
  actor_name text DEFAULT '' NOT NULL,
  actor_user_id text,
  counts text DEFAULT '{}' NOT NULL,
  status text DEFAULT 'applied' NOT NULL,
  undone_at integer,
  undone_by text DEFAULT '' NOT NULL,
  undo_note text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE TABLE IF NOT EXISTS price_import_rows (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  import_id integer NOT NULL REFERENCES price_imports(id) ON DELETE cascade,
  product_id integer NOT NULL,
  action text NOT NULL,
  before text,
  after text DEFAULT '{}' NOT NULL
);
CREATE INDEX IF NOT EXISTS price_import_rows_import_idx ON price_import_rows (import_id);
