-- Sell products (Damien, 30 Oct). New tables and one new column only.
-- Nothing already in Ops is changed by this file.
CREATE TABLE IF NOT EXISTS product_sales (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  request_key text NOT NULL,
  mode text NOT NULL,
  buyer_kind text NOT NULL,
  installer_id integer REFERENCES installers(id) ON DELETE set null,
  contact_id integer REFERENCES contacts(id) ON DELETE set null,
  company_id integer REFERENCES companies(id) ON DELETE set null,
  job_id integer REFERENCES jobs(id) ON DELETE set null,
  quote_id integer REFERENCES quotes(id) ON DELETE set null,
  sales_category text DEFAULT 'customer' NOT NULL,
  order_needed integer DEFAULT false NOT NULL,
  note text DEFAULT '' NOT NULL,
  created_by_name text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS product_sales_request_key_unique ON product_sales (request_key);
CREATE INDEX IF NOT EXISTS product_sales_job_idx ON product_sales (job_id);
CREATE TABLE IF NOT EXISTS product_sale_lines (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  sale_id integer NOT NULL REFERENCES product_sales(id) ON DELETE cascade,
  quote_item_id integer REFERENCES quote_items(id) ON DELETE set null,
  product_id integer REFERENCES products(id) ON DELETE set null,
  description text NOT NULL,
  qty real DEFAULT 0 NOT NULL,
  unit text DEFAULT 'each' NOT NULL,
  unit_price real DEFAULT 0 NOT NULL,
  from_stock real DEFAULT 0 NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS product_sale_lines_sale_idx ON product_sale_lines (sale_id);
CREATE TABLE IF NOT EXISTS supply_handovers (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE cascade,
  quote_item_id integer REFERENCES quote_items(id) ON DELETE set null,
  product_id integer REFERENCES products(id) ON DELETE set null,
  description text NOT NULL,
  unit text DEFAULT 'each' NOT NULL,
  qty real DEFAULT 0 NOT NULL,
  kind text NOT NULL,
  handed_on text NOT NULL,
  collected_by text DEFAULT '' NOT NULL,
  note text DEFAULT '' NOT NULL,
  batch_key text NOT NULL,
  actor_name text DEFAULT '' NOT NULL,
  actor_role text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS supply_handovers_job_idx ON supply_handovers (job_id);
CREATE INDEX IF NOT EXISTS supply_handovers_batch_idx ON supply_handovers (batch_key);
ALTER TABLE job_materials ADD COLUMN sale_line_id integer;
