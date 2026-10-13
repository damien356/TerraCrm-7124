-- Fix list 11 Oct, item 15: notifications to the office become alerts in Terra Ops, plus a push.
-- New table only. Nothing existing is changed.
CREATE TABLE IF NOT EXISTS alerts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  kind text NOT NULL,
  title text DEFAULT '' NOT NULL,
  body text DEFAULT '' NOT NULL,
  job_id integer REFERENCES jobs(id) ON DELETE cascade,
  data text DEFAULT '{}' NOT NULL,
  read_at integer,
  read_by_name text DEFAULT '' NOT NULL,
  emailed_at integer,
  pushed integer DEFAULT 0 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_open_idx ON alerts (read_at, created_at);
CREATE INDEX IF NOT EXISTS alerts_job_idx ON alerts (job_id);
