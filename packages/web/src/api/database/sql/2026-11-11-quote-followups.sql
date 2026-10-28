-- Quote follow-up emails (28 Oct). Two new tables. Nothing existing is changed.
-- One sequence per quote number (every version shares it), and one row per step (day 3, 7, 14, 25).
CREATE TABLE IF NOT EXISTS quote_followups (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  quote_number integer NOT NULL,
  quote_id integer REFERENCES quotes(id) ON DELETE set null,
  job_id integer REFERENCES jobs(id) ON DELETE set null,
  contact_id integer REFERENCES contacts(id) ON DELETE set null,
  company_id integer REFERENCES companies(id) ON DELETE set null,
  to_address text,
  cc_addresses text DEFAULT '' NOT NULL,
  audience text DEFAULT 'homeowner' NOT NULL,
  anchor_date text NOT NULL,
  time_zone text DEFAULT 'Australia/Brisbane' NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  reason text,
  paused_until text,
  replies_seen_at integer NOT NULL,
  assigned_profile_id integer REFERENCES profiles(id) ON DELETE set null,
  assigned_name text DEFAULT '' NOT NULL,
  consent_basis text DEFAULT '' NOT NULL,
  enrolled_by_name text DEFAULT '' NOT NULL,
  enrolled_how text DEFAULT 'on_send' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT quote_followups_number_uq UNIQUE(quote_number)
);
CREATE TABLE IF NOT EXISTS quote_followup_steps (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  followup_id integer NOT NULL REFERENCES quote_followups(id) ON DELETE cascade,
  quote_number integer NOT NULL,
  step integer NOT NULL,
  due_date text NOT NULL,
  due_at integer NOT NULL,
  date_agreed integer DEFAULT 0 NOT NULL,
  status text DEFAULT 'scheduled' NOT NULL,
  reason text,
  quote_id integer REFERENCES quotes(id) ON DELETE set null,
  to_address text,
  cc_address text,
  subject text,
  body text,
  edited integer DEFAULT 0 NOT NULL,
  message_id integer REFERENCES messages(id) ON DELETE set null,
  sent_at integer,
  error text,
  attempts integer DEFAULT 0 NOT NULL,
  by_name text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT quote_followup_steps_uq UNIQUE(quote_number, step)
);
CREATE INDEX IF NOT EXISTS quote_followup_steps_due_idx ON quote_followup_steps (status, due_at);
CREATE INDEX IF NOT EXISTS quote_followups_contact_idx ON quote_followups (contact_id);
