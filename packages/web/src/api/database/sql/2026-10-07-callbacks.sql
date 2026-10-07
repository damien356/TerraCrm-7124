-- Callbacks: a return visit linked to the original job.
-- Additive only. No existing row changes. Applied by script after a full
-- backup, never through db:push.

-- The original job. Every callback in a chain points at the original.
ALTER TABLE jobs ADD COLUMN parent_job_id integer REFERENCES jobs(id) ON DELETE SET NULL;
-- 1, 2, 3 within the chain.
ALTER TABLE jobs ADD COLUMN callback_seq integer;
-- Shown instead of the number, e.g. "3981-C1". Null on normal jobs.
ALTER TABLE jobs ADD COLUMN display_number text;
-- installer_error · product_fault · customer_damage · wear_and_tear · warranty · other
ALTER TABLE jobs ADD COLUMN callback_cause text;
-- 1 = quoted and invoiced as normal, 0 = nothing billed.
ALTER TABLE jobs ADD COLUMN callback_chargeable integer;
-- Installer error only: is the installer paid for the return visit.
ALTER TABLE jobs ADD COLUMN callback_pay_installer integer;

CREATE INDEX IF NOT EXISTS jobs_parent_idx ON jobs (parent_job_id);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_display_number_uq ON jobs (display_number);

-- What fixing a callback cost. Tracked and reported only. Admin only.
CREATE TABLE IF NOT EXISTS callback_costs (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  installer_id integer REFERENCES installers(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'labour',
  description text NOT NULL DEFAULT '',
  amount real NOT NULL DEFAULT 0,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS callback_costs_job_idx ON callback_costs (job_id);
CREATE INDEX IF NOT EXISTS callback_costs_installer_idx ON callback_costs (installer_id);
