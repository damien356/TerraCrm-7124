-- Measure booking stage 0 (foundations). New tables and new columns only.
-- No existing value is changed by this file. The two new columns take their
-- default on every existing row: job_tasks.version = 1, profiles.duties = ''.
-- Nothing reads them until the booking_safety setting is switched on.

-- Structured history: who changed what, from what, to what, and why.
-- Plain integer ids, no foreign keys, so deleting a job never deletes or blocks its audit trail.
CREATE TABLE IF NOT EXISTS audit_events (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  entity_type text NOT NULL,
  entity_id integer,
  job_id integer,
  task_id integer,
  action text NOT NULL,
  before_json text,
  after_json text,
  reason text,
  request_key text,
  actor_user_id text,
  actor_name text DEFAULT 'System' NOT NULL,
  actor_role text DEFAULT 'system' NOT NULL,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_job_idx ON audit_events (job_id);

-- Duplicate protection. One row per login and key. A repeat of the same key
-- gets the first answer back instead of doing the work again.
CREATE TABLE IF NOT EXISTS request_keys (
  actor_user_id text NOT NULL,
  key text NOT NULL,
  action text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  response_json text,
  created_at integer NOT NULL,
  completed_at integer,
  PRIMARY KEY (actor_user_id, key)
);
CREATE INDEX IF NOT EXISTS request_keys_created_idx ON request_keys (created_at);

-- Stale edit check: every guarded write bumps it.
ALTER TABLE job_tasks ADD COLUMN version integer DEFAULT 1 NOT NULL;

-- Extra duties on top of the login role, comma separated: estimator, supervisor.
ALTER TABLE profiles ADD COLUMN duties text DEFAULT '' NOT NULL;
