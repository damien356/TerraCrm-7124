-- SWMS Stage 3: site checks on the phone, red cards, GPS, the builder email.
-- Additive only. No existing row changes. Applied by script after a full
-- backup, never through db:push.

-- Where the phone was when Crew signed. Null on older signings.
ALTER TABLE swms_records ADD COLUMN gps_lat real;
ALTER TABLE swms_records ADD COLUMN gps_lng real;
-- Metres.
ALTER TABLE swms_records ADD COLUMN gps_accuracy real;
-- ok · denied · timeout · unavailable · not_sent (an older app). Null before Stage 3.
ALTER TABLE swms_records ADD COLUMN gps_status text;
-- JSON list of { checkId, question, answer, flagged, blocks, cleared }.
ALTER TABLE swms_records ADD COLUMN site_answers text;

-- A flagged site check answer. The red card on the job. Clearing keeps the row.
CREATE TABLE IF NOT EXISTS swms_flags (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  record_id integer REFERENCES swms_records(id) ON DELETE SET NULL,
  task_id integer REFERENCES job_tasks(id) ON DELETE SET NULL,
  installer_id integer REFERENCES installers(id) ON DELETE SET NULL,
  installer_name text NOT NULL DEFAULT '',
  check_id integer REFERENCES swms_site_checks(id) ON DELETE SET NULL,
  question text NOT NULL,
  answer text NOT NULL,
  blocks integer NOT NULL DEFAULT 0,
  emailed integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL,
  cleared_by_name text,
  cleared_at integer,
  clear_note text
);
CREATE INDEX IF NOT EXISTS swms_flags_job_idx ON swms_flags (job_id, cleared_at);

-- Every time Office emails a signed SWMS to the builder. One row per address.
CREATE TABLE IF NOT EXISTS swms_emails (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  record_id integer REFERENCES swms_records(id) ON DELETE SET NULL,
  to_email text NOT NULL,
  sent_by_name text NOT NULL DEFAULT '',
  sent_at integer NOT NULL,
  ok integer NOT NULL DEFAULT 0,
  error text
);
CREATE INDEX IF NOT EXISTS swms_emails_job_idx ON swms_emails (job_id, sent_at);
