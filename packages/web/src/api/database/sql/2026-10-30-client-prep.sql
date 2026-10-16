-- Client prep messages (notes 18.56, 16 Oct). Three new job columns and one new table. Nothing existing is changed.
ALTER TABLE jobs ADD COLUMN furniture_moving integer;
ALTER TABLE jobs ADD COLUMN prep_on integer;
ALTER TABLE jobs ADD COLUMN apt_checks text DEFAULT '{}' NOT NULL;
CREATE TABLE IF NOT EXISTS prep_sends (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE cascade,
  task_id integer REFERENCES job_tasks(id) ON DELETE set null,
  kind text NOT NULL,
  for_date text NOT NULL,
  recipient text DEFAULT '' NOT NULL,
  contact_id integer REFERENCES contacts(id) ON DELETE set null,
  channel text DEFAULT '' NOT NULL,
  to_address text,
  status text DEFAULT 'sending' NOT NULL,
  detail text,
  message_id integer REFERENCES messages(id) ON DELETE set null,
  by_name text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT prep_sends_uq UNIQUE(job_id, kind, for_date, recipient)
);
CREATE INDEX IF NOT EXISTS prep_sends_job_idx ON prep_sends (job_id);
-- The one job already ticked Furniture on site is a Yes. Every other job stays not answered.
UPDATE jobs SET furniture_moving = 1 WHERE furniture_on_site = 1 AND furniture_moving IS NULL;
