-- Referral fees (notes 18.47). Three new tables and one new column. Nothing existing is changed.
ALTER TABLE office_tasks ADD COLUMN admin_only integer DEFAULT false NOT NULL;
CREATE TABLE IF NOT EXISTS referrers (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  company_id integer REFERENCES companies(id) ON DELETE cascade,
  contact_id integer REFERENCES contacts(id) ON DELETE cascade,
  active integer DEFAULT true NOT NULL,
  rate_percent real DEFAULT 0 NOT NULL,
  abn text,
  gst_registered integer DEFAULT false NOT NULL,
  bank_account_name text,
  bank_bsb text,
  bank_account_number text,
  remittance_email text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT referrers_company_uq UNIQUE(company_id),
  CONSTRAINT referrers_contact_uq UNIQUE(contact_id)
);
CREATE TABLE IF NOT EXISTS job_referrals (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE cascade,
  referrer_id integer NOT NULL REFERENCES referrers(id) ON DELETE cascade,
  fee_type text DEFAULT 'default' NOT NULL,
  fee_value real,
  set_by_name text DEFAULT '' NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  amount real DEFAULT 0 NOT NULL,
  flag_reason text,
  task_id integer REFERENCES office_tasks(id) ON DELETE set null,
  invoice_key text,
  invoice_name text,
  invoice_amount real,
  paid_on text,
  paid_by_name text,
  decided_by_name text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT job_referrals_job_uq UNIQUE(job_id)
);
CREATE INDEX IF NOT EXISTS job_referrals_referrer_idx ON job_referrals (referrer_id);
CREATE TABLE IF NOT EXISTS referral_snapshots (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  quote_id integer REFERENCES quotes(id) ON DELETE cascade,
  variation_id integer REFERENCES variations(id) ON DELETE cascade,
  referrer_id integer,
  name text DEFAULT '' NOT NULL,
  fee_type text DEFAULT 'percent' NOT NULL,
  fee_value real DEFAULT 0 NOT NULL,
  base real DEFAULT 0 NOT NULL,
  amount real DEFAULT 0 NOT NULL,
  blocked_reason text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT referral_snapshots_quote_uq UNIQUE(quote_id),
  CONSTRAINT referral_snapshots_variation_uq UNIQUE(variation_id)
);
