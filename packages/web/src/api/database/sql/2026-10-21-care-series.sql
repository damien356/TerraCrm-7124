-- After-job care series: the plain emails from Damien after a job is completed.
-- New columns on products and jobs, and three new tables. Nothing existing is changed.
-- See api/lib/care-engine.ts and PROJECT_NOTES section 18.37.

-- Fibre and pile on every carpet in the price book (wool, wool_blend, nylon, polypropylene, polyester; cut, loop, cut_loop).
ALTER TABLE products ADD COLUMN fibre text DEFAULT '' NOT NULL;
ALTER TABLE products ADD COLUMN pile text DEFAULT '' NOT NULL;

-- What the job put down, for the care emails. Blank means worked out from the quote and the job text.
ALTER TABLE jobs ADD COLUMN care_floors text DEFAULT '' NOT NULL;
ALTER TABLE jobs ADD COLUMN fibre text DEFAULT '' NOT NULL;
ALTER TABLE jobs ADD COLUMN pile text DEFAULT '' NOT NULL;
-- Null follows the Landlord tag on the job contact. 1 or 0 is set on the job.
ALTER TABLE jobs ADD COLUMN care_landlord integer;
-- Blank until the care engine has looked at the completed job: added, waiting_wool, skipped.
ALTER TABLE jobs ADD COLUMN care_state text DEFAULT '' NOT NULL;
ALTER TABLE jobs ADD COLUMN care_note text DEFAULT '' NOT NULL;

-- One row per homeowner in the series. A later job adds its floors. The same floor type restarts only after 12 months.
CREATE TABLE care_members (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  contact_id integer NOT NULL REFERENCES contacts(id) ON DELETE cascade,
  status text DEFAULT 'active' NOT NULL,
  stop_reason text DEFAULT '' NOT NULL,
  floors text DEFAULT '[]' NOT NULL,
  fibre text DEFAULT '' NOT NULL,
  pile text DEFAULT '' NOT NULL,
  landlord integer DEFAULT 0 NOT NULL,
  started_at integer NOT NULL,
  last_job_id integer REFERENCES jobs(id) ON DELETE set null,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX care_members_contact_uq ON care_members (contact_id);

-- Every care email sent, resent or skipped, with when it was opened.
CREATE TABLE care_sends (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  member_id integer NOT NULL REFERENCES care_members(id) ON DELETE cascade,
  contact_id integer REFERENCES contacts(id) ON DELETE set null,
  job_id integer REFERENCES jobs(id) ON DELETE set null,
  code text NOT NULL,
  kind text DEFAULT 'series' NOT NULL,
  due_at integer,
  status text DEFAULT 'sent' NOT NULL,
  send_id integer REFERENCES sends(id) ON DELETE set null,
  sent_at integer,
  opened_at integer,
  resend_send_id integer REFERENCES sends(id) ON DELETE set null,
  resent_at integer,
  note text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX care_sends_member_idx ON care_sends (member_id);
CREATE INDEX care_sends_send_idx ON care_sends (send_id);
CREATE INDEX care_sends_resend_idx ON care_sends (resend_send_id);

-- Damien's edits to a care email. No row means the email as written in api/lib/care-templates.ts.
CREATE TABLE care_templates (
  code text PRIMARY KEY NOT NULL,
  subject text DEFAULT '' NOT NULL,
  body text DEFAULT '' NOT NULL,
  active integer DEFAULT 1 NOT NULL,
  updated_at integer NOT NULL
);
