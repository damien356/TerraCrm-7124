-- Section 2: send quote, online accept, deposit (9 Oct 2026).
-- Applied by script after a full backup, never through db:push.
--
-- 1. invoices is rebuilt so its number holds the ref as text (IQ188000-1).
--    The table had 0 rows on live when this was written, and no cash_events
--    row points at an invoice. The script checks both again and stops if not.
-- 2. Four new tables. Nothing else changes.

DROP TABLE IF EXISTS invoices;

CREATE TABLE invoices (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  number text NOT NULL,
  job_number integer NOT NULL,
  seq integer NOT NULL,
  job_id integer REFERENCES jobs(id) ON DELETE SET NULL,
  quote_id integer REFERENCES quotes(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'other',
  label text NOT NULL DEFAULT '',
  bill_to_type text NOT NULL DEFAULT 'contact',
  bill_to_contact_id integer REFERENCES contacts(id) ON DELETE SET NULL,
  bill_to_company_id integer REFERENCES companies(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft',
  subtotal real NOT NULL DEFAULT 0,
  gst real NOT NULL DEFAULT 0,
  total real NOT NULL DEFAULT 0,
  amount_paid real NOT NULL DEFAULT 0,
  due_date integer,
  payment_method text,
  marked_paid_by_name text,
  xero_invoice_id text,
  stripe_payment_intent_id text,
  paid_at integer,
  voided_at integer,
  void_reason text,
  created_by_name text NOT NULL DEFAULT '',
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX invoices_number_unique ON invoices (number);
CREATE UNIQUE INDEX invoices_job_number_seq_unique ON invoices (job_number, seq);
CREATE INDEX invoices_job_idx ON invoices (job_id);

CREATE TABLE IF NOT EXISTS quote_links (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  token text NOT NULL,
  views integer NOT NULL DEFAULT 0,
  first_viewed_at integer,
  last_viewed_at integer,
  view_push_sent_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS quote_links_quote_id_unique ON quote_links (quote_id);
CREATE UNIQUE INDEX IF NOT EXISTS quote_links_token_unique ON quote_links (token);

CREATE TABLE IF NOT EXISTS quote_signatures (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  name text NOT NULL,
  position text NOT NULL DEFAULT '',
  email text,
  signature_json text NOT NULL,
  terms_version text NOT NULL DEFAULT '',
  signed_at integer NOT NULL,
  ip text,
  user_agent text,
  pdf_key text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS quote_signatures_quote_idx ON quote_signatures (quote_id);

CREATE TABLE IF NOT EXISTS material_selections (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  quote_id integer REFERENCES quotes(id) ON DELETE SET NULL,
  token text NOT NULL,
  contact_id integer REFERENCES contacts(id) ON DELETE SET NULL,
  sent_to text,
  status text NOT NULL DEFAULT 'waiting',
  sent_at integer,
  submitted_at integer,
  submitted_name text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS material_selections_token_unique ON material_selections (token);
CREATE INDEX IF NOT EXISTS material_selections_job_idx ON material_selections (job_id);

CREATE TABLE IF NOT EXISTS material_selection_items (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  selection_id integer NOT NULL REFERENCES material_selections(id) ON DELETE CASCADE,
  area_id integer REFERENCES job_areas(id) ON DELETE SET NULL,
  room text NOT NULL DEFAULT '',
  product text NOT NULL DEFAULT '',
  colour text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS material_selection_items_sel_idx ON material_selection_items (selection_id);
