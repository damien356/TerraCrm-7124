-- Hourly contractors (Pedro brief, 22 Oct). New tables and new empty columns only.
-- No existing value is changed by this file. Pay terms and vehicles start empty:
-- they are entered by the office, never seeded here.
CREATE TABLE IF NOT EXISTS installer_pay_terms (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  installer_id integer NOT NULL REFERENCES installers(id) ON DELETE cascade,
  basis text DEFAULT 'hourly' NOT NULL,
  base_rate real NOT NULL,
  weekend_multiplier real DEFAULT 1.5 NOT NULL,
  night_multiplier real DEFAULT 2 NOT NULL,
  gst_registered integer DEFAULT false NOT NULL,
  gst_note text,
  default_for_new integer DEFAULT true NOT NULL,
  effective_from text NOT NULL,
  effective_to text,
  note text,
  created_by_name text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS pay_terms_installer_idx ON installer_pay_terms (installer_id, effective_from);
CREATE TABLE IF NOT EXISTS vehicles (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL,
  usual_driver_id integer REFERENCES installers(id) ON DELETE set null,
  daily_allowance real DEFAULT 50 NOT NULL,
  is_test integer DEFAULT false NOT NULL,
  active integer DEFAULT true NOT NULL,
  notes text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE TABLE IF NOT EXISTS work_sessions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  installer_id integer NOT NULL REFERENCES installers(id) ON DELETE cascade,
  task_id integer NOT NULL REFERENCES job_tasks(id) ON DELETE cascade,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE cascade,
  category text DEFAULT 'site' NOT NULL,
  client_key text NOT NULL,
  work_date text NOT NULL,
  started_at integer NOT NULL,
  ended_at integer,
  adj_started_at integer,
  adj_ended_at integer,
  source text DEFAULT 'app' NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  vehicle_id integer REFERENCES vehicles(id) ON DELETE set null,
  note text,
  correction_requested_at integer,
  correction_note text,
  band_split text,
  band_confirmed_by text,
  band_confirmed_at integer,
  payable integer,
  approved_minutes integer,
  paid_break_minutes integer,
  unpaid_break_minutes integer,
  terms_id integer REFERENCES installer_pay_terms(id) ON DELETE set null,
  rate_base real,
  weekend_multiplier real,
  night_multiplier real,
  gst_registered integer,
  pay_lines text,
  approved_pay real,
  approved_at integer,
  approved_by_name text,
  invoice_id integer REFERENCES installer_invoices(id) ON DELETE set null,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS work_sessions_key_unique ON work_sessions (installer_id, client_key);
CREATE UNIQUE INDEX IF NOT EXISTS work_sessions_one_open ON work_sessions (installer_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS work_sessions_task_idx ON work_sessions (task_id, status);
CREATE INDEX IF NOT EXISTS work_sessions_job_idx ON work_sessions (job_id);
CREATE INDEX IF NOT EXISTS work_sessions_vehicle_idx ON work_sessions (vehicle_id, work_date);
CREATE TABLE IF NOT EXISTS work_breaks (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  session_id integer NOT NULL REFERENCES work_sessions(id) ON DELETE cascade,
  client_key text NOT NULL,
  started_at integer NOT NULL,
  ended_at integer,
  paid integer,
  decided_by_name text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS work_breaks_key_unique ON work_breaks (session_id, client_key);
CREATE UNIQUE INDEX IF NOT EXISTS work_breaks_one_open ON work_breaks (session_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS work_time_events (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  session_id integer REFERENCES work_sessions(id) ON DELETE cascade,
  installer_id integer REFERENCES installers(id) ON DELETE set null,
  task_id integer REFERENCES job_tasks(id) ON DELETE set null,
  action text NOT NULL,
  actor_name text DEFAULT '' NOT NULL,
  actor_role text DEFAULT '' NOT NULL,
  before text,
  after text,
  reason text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS work_time_events_session_idx ON work_time_events (session_id, created_at);
CREATE TABLE IF NOT EXISTS vehicle_days (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  vehicle_id integer NOT NULL REFERENCES vehicles(id) ON DELETE cascade,
  use_date text NOT NULL,
  allowance real NOT NULL,
  note text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_days_unique ON vehicle_days (vehicle_id, use_date);
CREATE TABLE IF NOT EXISTS vehicle_day_shares (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  vehicle_day_id integer NOT NULL REFERENCES vehicle_days(id) ON DELETE cascade,
  task_id integer NOT NULL REFERENCES job_tasks(id) ON DELETE cascade,
  share real NOT NULL,
  note text,
  by_name text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_day_shares_unique ON vehicle_day_shares (vehicle_day_id, task_id);
-- The normal subcontract allowance for the task's scope, kept as a comparator
-- when an hourly worker does the work. Frozen at assignment like labour_cost.
ALTER TABLE job_tasks ADD COLUMN benchmark_cost real;
ALTER TABLE job_tasks ADD COLUMN benchmark_breakdown text;
ALTER TABLE job_tasks ADD COLUMN benchmark_priced_on text;
ALTER TABLE job_tasks ADD COLUMN benchmark_note text;
ALTER TABLE job_tasks ADD COLUMN benchmark_vehicle text DEFAULT 'unknown' NOT NULL;
ALTER TABLE job_tasks ADD COLUMN planned_hours real;
ALTER TABLE job_tasks ADD COLUMN planned_vehicle_days real;
