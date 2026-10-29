-- Task G (29 Oct): read how each Xero payment on a client invoice was made.
-- One new table. Nothing existing is changed or removed.
CREATE TABLE IF NOT EXISTS xero_payment_reads (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  tenant_id text NOT NULL,
  xero_payment_id text NOT NULL,
  invoice_id integer REFERENCES invoices(id) ON DELETE set null,
  xero_invoice_id text,
  amount real DEFAULT 0 NOT NULL,
  recorded real DEFAULT 0 NOT NULL,
  account_code text,
  account_name text,
  account_type text,
  kind text NOT NULL,
  paid_on integer,
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS xero_payment_reads_uq ON xero_payment_reads (tenant_id, xero_payment_id);
CREATE INDEX IF NOT EXISTS xero_payment_reads_invoice_idx ON xero_payment_reads (invoice_id);
