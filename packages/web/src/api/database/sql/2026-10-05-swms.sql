-- SWMS for Terra Crew. Additive only. Applied by script after a full backup,
-- never through db:push.
ALTER TABLE contacts ADD COLUMN requires_swms integer NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN requires_swms integer NOT NULL DEFAULT 0;
-- Null follows the client, 1 forces on, 0 forces off.
ALTER TABLE jobs ADD COLUMN requires_swms integer;
CREATE TABLE IF NOT EXISTS safety_docs (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  code text NOT NULL,
  product text NOT NULL,
  supplier text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'sds',
  revision text NOT NULL DEFAULT '',
  issued_on text,
  region text NOT NULL DEFAULT 'AU',
  storage_key text NOT NULL,
  filename text NOT NULL DEFAULT '',
  size_bytes integer,
  notes text NOT NULL DEFAULT '',
  active integer NOT NULL DEFAULT 1,
  uploaded_by_name text NOT NULL DEFAULT '',
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS safety_docs_code_idx ON safety_docs (code, active);
CREATE TABLE IF NOT EXISTS swms_records (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE cascade,
  task_id integer REFERENCES job_tasks(id) ON DELETE set null,
  installer_id integer REFERENCES installers(id) ON DELETE set null,
  installer_name text NOT NULL DEFAULT '',
  work_date text NOT NULL,
  kind text NOT NULL DEFAULT 'full',
  based_on_id integer,
  site_address text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '{}',
  custom_hazard text NOT NULL DEFAULT '',
  signed_name text NOT NULL,
  signature text NOT NULL DEFAULT '{}',
  sds_doc_ids text NOT NULL DEFAULT '[]',
  pdf_key text,
  signed_at integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS swms_job_day_idx ON swms_records (job_id, work_date);
CREATE INDEX IF NOT EXISTS swms_installer_idx ON swms_records (installer_id, work_date);
