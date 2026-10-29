-- Task H (29 Oct): installer who also buys (one confirmed link), and contras.
-- Two new tables. Nothing existing is changed or removed.
CREATE TABLE IF NOT EXISTS installer_buyer_links (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  installer_id integer NOT NULL REFERENCES installers(id) ON DELETE cascade,
  bill_to_type text NOT NULL,
  contact_id integer REFERENCES contacts(id) ON DELETE cascade,
  company_id integer REFERENCES companies(id) ON DELETE cascade,
  basis text NOT NULL,
  reason text,
  installer_abn text,
  installer_legal_name text,
  buyer_name text DEFAULT '' NOT NULL,
  buyer_abn text,
  confirmed_by_name text NOT NULL,
  confirmed_by_user_id text,
  confirmed_at integer NOT NULL,
  xero_tenant_id text,
  xero_contact_id text,
  xero_contact_name text,
  xero_pinned_by_name text,
  xero_pinned_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS installer_buyer_links_installer_uq ON installer_buyer_links (installer_id);
CREATE UNIQUE INDEX IF NOT EXISTS installer_buyer_links_contact_uq ON installer_buyer_links (contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS installer_buyer_links_company_uq ON installer_buyer_links (company_id);

CREATE TABLE IF NOT EXISTS xero_contras (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  request_key text NOT NULL,
  tenant_id text NOT NULL,
  installer_id integer NOT NULL REFERENCES installers(id) ON DELETE restrict,
  invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE restrict,
  invoice_number text NOT NULL,
  xero_invoice_id text NOT NULL,
  bill_xero_id text NOT NULL,
  bill_number text DEFAULT '' NOT NULL,
  installer_invoice_id integer REFERENCES installer_invoices(id) ON DELETE set null,
  amount real NOT NULL,
  contra_account text NOT NULL,
  paid_on text NOT NULL,
  status text DEFAULT 'draft' NOT NULL,
  invoice_due_before real NOT NULL,
  bill_due_before real NOT NULL,
  bill_total real DEFAULT 0 NOT NULL,
  invoice_total real DEFAULT 0 NOT NULL,
  agreement_how text NOT NULL,
  agreement_note text NOT NULL,
  agreement_on text NOT NULL,
  same_entity_basis text NOT NULL,
  prepared_by_name text NOT NULL,
  prepared_at integer NOT NULL,
  approved_by_name text,
  approved_at integer,
  approval_text text,
  inv_payment_id text,
  inv_posted_at integer,
  bill_payment_id text,
  bill_posted_at integer,
  confirmed_at integer,
  cancelled_by_name text,
  last_error text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS xero_contras_request_uq ON xero_contras (request_key);
CREATE INDEX IF NOT EXISTS xero_contras_installer_idx ON xero_contras (installer_id);
CREATE UNIQUE INDEX IF NOT EXISTS xero_contras_open_invoice_uq ON xero_contras (invoice_id) WHERE status in ('draft','approved','posting','incomplete','posted');
CREATE UNIQUE INDEX IF NOT EXISTS xero_contras_open_bill_uq ON xero_contras (bill_xero_id) WHERE status in ('draft','approved','posting','incomplete','posted');
