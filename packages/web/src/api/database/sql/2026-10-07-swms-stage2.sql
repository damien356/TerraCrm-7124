-- SWMS Stage 2: templates and task blocks in the database.
-- Additive only. No existing row changes. Applied by script after a full
-- backup, never through db:push.

ALTER TABLE safety_docs ADD COLUMN review_on text;

CREATE TABLE IF NOT EXISTS sds_products (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  code text NOT NULL,
  product text NOT NULL,
  supplier text NOT NULL DEFAULT '',
  archived integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sds_products_code_unique ON sds_products (code);

CREATE TABLE IF NOT EXISTS swms_blocks (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  key text NOT NULL,
  title text NOT NULL,
  task text NOT NULL DEFAULT '',
  ppe text NOT NULL DEFAULT '[]',
  items text NOT NULL DEFAULT '[]',
  archived_at integer,
  updated_by_name text NOT NULL DEFAULT '',
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS swms_blocks_key_unique ON swms_blocks (key);

CREATE TABLE IF NOT EXISTS swms_templates (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  work_type text NOT NULL DEFAULT '',
  activity text NOT NULL DEFAULT '',
  ppe text NOT NULL DEFAULT '[]',
  block_ids text NOT NULL DEFAULT '[]',
  every_job integer NOT NULL DEFAULT 0,
  match_terms text NOT NULL DEFAULT '[]',
  category_terms text NOT NULL DEFAULT '[]',
  also_adds text NOT NULL DEFAULT '[]',
  replaces_key text,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at integer,
  updated_by_name text NOT NULL DEFAULT '',
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS swms_templates_key_unique ON swms_templates (key);

CREATE TABLE IF NOT EXISTS swms_template_versions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  template_id integer NOT NULL REFERENCES swms_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content text NOT NULL,
  what_changed text NOT NULL DEFAULT '',
  published_by_name text NOT NULL DEFAULT '',
  published_at integer NOT NULL,
  reviewed_by_name text NOT NULL DEFAULT '',
  reviewed_by_qualification text NOT NULL DEFAULT '',
  reviewed_on text
);
CREATE UNIQUE INDEX IF NOT EXISTS swms_template_versions_uq ON swms_template_versions (template_id, version);

CREATE TABLE IF NOT EXISTS swms_site_checks (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  question text NOT NULL,
  answers text NOT NULL DEFAULT '["yes","no"]',
  flag_on text NOT NULL DEFAULT '["no","unsure"]',
  blocks integer NOT NULL DEFAULT 0,
  applies_all integer NOT NULL DEFAULT 1,
  template_keys text NOT NULL DEFAULT '[]',
  sort_order integer NOT NULL DEFAULT 0,
  archived_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS swms_changes (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  entity_type text NOT NULL,
  entity_id integer,
  action text NOT NULL,
  summary text NOT NULL DEFAULT '',
  actor_name text NOT NULL DEFAULT 'System',
  actor_role text NOT NULL DEFAULT 'system',
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS swms_changes_entity_idx ON swms_changes (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS job_swms_templates (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  template_key text NOT NULL,
  added_by_name text NOT NULL DEFAULT '',
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS job_swms_templates_uq ON job_swms_templates (job_id, template_key);
