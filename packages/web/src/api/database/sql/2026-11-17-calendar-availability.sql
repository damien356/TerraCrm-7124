-- Bookable staff and Google Calendar availability (Damien, 30 Oct).
-- Four new tables and one new skill row. Nothing existing is changed or removed.
-- No one is made bookable and no calendar is linked by this file: each person
-- does that themselves in Schedule, My calendar.
CREATE TABLE IF NOT EXISTS staff_cards (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE cascade,
  installer_id integer NOT NULL REFERENCES installers(id) ON DELETE cascade,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_cards_profile_uq ON staff_cards (profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS staff_cards_installer_uq ON staff_cards (installer_id);

CREATE TABLE IF NOT EXISTS calendar_links (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  installer_id integer NOT NULL REFERENCES installers(id) ON DELETE cascade,
  owner_profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE cascade,
  google_email text,
  refresh_token_sealed text,
  scopes text DEFAULT '' NOT NULL,
  calendar_ids text DEFAULT '[]' NOT NULL,
  calendars_json text DEFAULT '[]' NOT NULL,
  buffer_before_min integer DEFAULT 15 NOT NULL,
  buffer_after_min integer DEFAULT 15 NOT NULL,
  cache_from integer,
  cache_to integer,
  last_sync_ok_at integer,
  last_sync_try_at integer,
  last_error text,
  connected_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_links_installer_uq ON calendar_links (installer_id);

CREATE TABLE IF NOT EXISTS calendar_busy (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  link_id integer NOT NULL REFERENCES calendar_links(id) ON DELETE cascade,
  calendar_id text NOT NULL,
  start_at integer NOT NULL,
  end_at integer NOT NULL,
  fetched_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_busy_link_idx ON calendar_busy (link_id, start_at);

CREATE TABLE IF NOT EXISTS calendar_overrides (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  task_id integer REFERENCES job_tasks(id) ON DELETE set null,
  installer_id integer NOT NULL REFERENCES installers(id) ON DELETE cascade,
  date text NOT NULL,
  slot_start text,
  slot_end text,
  clashes_json text DEFAULT '[]' NOT NULL,
  kind text DEFAULT 'clash' NOT NULL,
  reason text NOT NULL,
  approved_by_profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE cascade,
  approved_by_name text DEFAULT '' NOT NULL,
  source text DEFAULT 'book' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_overrides_task_idx ON calendar_overrides (task_id);
CREATE INDEX IF NOT EXISTS calendar_overrides_installer_idx ON calendar_overrides (installer_id, date);

-- The new booking type. Not an install: no prep questions, no prep messages.
INSERT INTO skills (name, group_name, default_crew_size, min_crew, recommended_crew, production_unit, extra_crew_uplift_pct, fixed_days, min_completion_photos, sort_order, active, created_at, updated_at)
SELECT 'Site visit / inspection', 'other', 1, 1, 1, 'each', 0, 0, 0, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM skills), 1, unixepoch(), unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM skills WHERE name = 'Site visit / inspection');
