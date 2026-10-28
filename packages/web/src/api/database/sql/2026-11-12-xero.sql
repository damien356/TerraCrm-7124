-- Xero connection (Damien, 28 Oct). Ops pushes client invoices to Xero and reads them back.
-- Three new tables and seven new columns on invoices. Nothing existing is changed or removed.

-- One row: the Xero organisation Ops is connected to. The refresh token is sealed with MAIL_TOKEN_KEY.
CREATE TABLE IF NOT EXISTS xero_connection (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  tenant_id text,
  tenant_name text DEFAULT '' NOT NULL,
  tenant_type text DEFAULT '' NOT NULL,
  tenants_json text DEFAULT '[]' NOT NULL,
  xero_connection_id text,
  refresh_token_sealed text,
  scopes text DEFAULT '' NOT NULL,
  connected_by_profile_id integer REFERENCES profiles(id) ON DELETE set null,
  connected_at integer,
  last_sync_at integer,
  last_error text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

-- Every push, link, read back and connect, kept so the office can see what went to Xero and why.
CREATE TABLE IF NOT EXISTS xero_sync_log (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  kind text NOT NULL,
  ok integer DEFAULT 1 NOT NULL,
  invoice_id integer REFERENCES invoices(id) ON DELETE set null,
  xero_id text,
  detail text DEFAULT '' NOT NULL,
  by_name text DEFAULT 'System' NOT NULL,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS xero_sync_log_invoice_idx ON xero_sync_log (invoice_id);
CREATE INDEX IF NOT EXISTS xero_sync_log_created_idx ON xero_sync_log (created_at);

-- Which Xero contact a Terra contact or company bills to, once matched or created.
CREATE TABLE IF NOT EXISTS xero_contact_links (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  tenant_id text NOT NULL,
  bill_to_key text NOT NULL,
  contact_id integer REFERENCES contacts(id) ON DELETE cascade,
  company_id integer REFERENCES companies(id) ON DELETE cascade,
  xero_contact_id text NOT NULL,
  xero_name text DEFAULT '' NOT NULL,
  how text DEFAULT 'matched' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT xero_contact_links_uq UNIQUE(tenant_id, bill_to_key)
);

-- What Xero last said about each pushed invoice. xero_invoice_id already exists.
ALTER TABLE invoices ADD COLUMN xero_status text;
ALTER TABLE invoices ADD COLUMN xero_amount_paid real;
ALTER TABLE invoices ADD COLUMN xero_amount_due real;
ALTER TABLE invoices ADD COLUMN xero_pushed_at integer;
ALTER TABLE invoices ADD COLUMN xero_pushed_by_name text;
ALTER TABLE invoices ADD COLUMN xero_synced_at integer;
ALTER TABLE invoices ADD COLUMN xero_issue text;
-- Which Xero organisation xero_invoice_id is in, so a test run on the Demo Company never sticks to a real invoice.
ALTER TABLE invoices ADD COLUMN xero_tenant_id text;
