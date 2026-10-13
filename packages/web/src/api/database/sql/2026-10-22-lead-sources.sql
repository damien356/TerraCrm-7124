-- Lead sources, landing pages and timber repair pricing (spec 14 Oct).
-- New columns on jobs and job_media, and five new tables. Nothing existing is changed.
-- See api/lib/lead-intake.ts, api/lib/timber-repair.ts and PROJECT_NOTES section 18.38.

-- The editable list of where a job came from. jobs.source holds the name.
CREATE TABLE lead_sources (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL,
  active integer DEFAULT 1 NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX lead_sources_name_uq ON lead_sources (name);

-- One row per landing page. The form key is what the page posts to: /api/leads/<form key>.
CREATE TABLE landing_pages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  url text DEFAULT '' NOT NULL,
  lead_source text DEFAULT '' NOT NULL,
  client_type text DEFAULT 'homeowner' NOT NULL,
  tags text DEFAULT '[]' NOT NULL,
  follow_up_on integer DEFAULT 1 NOT NULL,
  form_key text NOT NULL,
  conversion_label text DEFAULT '' NOT NULL,
  timber integer DEFAULT 0 NOT NULL,
  active integer DEFAULT 1 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX landing_pages_form_key_uq ON landing_pages (form_key);

-- Every form post, kept as sent. Spam is kept too, so nothing real is lost.
CREATE TABLE lead_submissions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  form_key text DEFAULT '' NOT NULL,
  landing_page_id integer REFERENCES landing_pages(id) ON DELETE set null,
  raw text DEFAULT '{}' NOT NULL,
  verdict text DEFAULT 'ok' NOT NULL,
  reason text DEFAULT '' NOT NULL,
  ip text DEFAULT '' NOT NULL,
  job_id integer REFERENCES jobs(id) ON DELETE set null,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX lead_submissions_created_idx ON lead_submissions (created_at);
CREATE INDEX lead_submissions_ip_idx ON lead_submissions (ip, created_at);

-- Monthly ad spend per landing page, typed in by Damien.
CREATE TABLE ad_spend (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  landing_page_id integer NOT NULL REFERENCES landing_pages(id) ON DELETE cascade,
  month text NOT NULL,
  amount real DEFAULT 0 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX ad_spend_page_month_uq ON ad_spend (landing_page_id, month);

-- One row per timber repair lead: what Marc is asked, what he said, and the quote it made.
CREATE TABLE repair_requests (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE cascade,
  installer_id integer REFERENCES installers(id) ON DELETE set null,
  repair_type text DEFAULT '' NOT NULL,
  area text DEFAULT '' NOT NULL,
  floor_type text DEFAULT '' NOT NULL,
  suburb text DEFAULT '' NOT NULL,
  token_hash text NOT NULL,
  expires_at integer NOT NULL,
  status text DEFAULT 'new' NOT NULL,
  marc_price real,
  marc_note text DEFAULT '' NOT NULL,
  client_price real,
  sms_out_id text DEFAULT '' NOT NULL,
  sms_cost real DEFAULT 0 NOT NULL,
  sms_count integer DEFAULT 0 NOT NULL,
  last_reply text DEFAULT '' NOT NULL,
  asked_at integer,
  replied_at integer,
  nudged_at integer,
  quote_id integer REFERENCES quotes(id) ON DELETE set null,
  task_id integer REFERENCES job_tasks(id) ON DELETE set null,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX repair_requests_job_uq ON repair_requests (job_id);
CREATE UNIQUE INDEX repair_requests_token_uq ON repair_requests (token_hash);
CREATE INDEX repair_requests_status_idx ON repair_requests (status);

-- Job tags (e.g. Timber repair), the page it came in on, and the ad click. gclid and utm are never sent to Crew.
ALTER TABLE jobs ADD COLUMN tags text DEFAULT '[]' NOT NULL;
ALTER TABLE jobs ADD COLUMN landing_page_id integer REFERENCES landing_pages(id) ON DELETE set null;
ALTER TABLE jobs ADD COLUMN gclid text DEFAULT '' NOT NULL;
ALTER TABLE jobs ADD COLUMN utm text DEFAULT '' NOT NULL;
-- JSON list of flags for the office, e.g. "Unknown landing page", "Address only in the message".
ALTER TABLE jobs ADD COLUMN lead_flags text DEFAULT '[]' NOT NULL;

-- Photo tags, e.g. the repair type on a timber repair photo.
ALTER TABLE job_media ADD COLUMN tags text DEFAULT '[]' NOT NULL;

-- The starting list. Editable in Settings, Leads.
INSERT INTO lead_sources (name, active, sort_order, created_at, updated_at) VALUES
  ('Google Ads: Medical & GP Clinic', 1, 1, strftime('%s','now'), strftime('%s','now')),
  ('Google Ads: Pharmacy', 1, 2, strftime('%s','now'), strftime('%s','now')),
  ('Google Ads: Commercial Kitchen', 1, 3, strftime('%s','now'), strftime('%s','now')),
  ('Google Ads: Herringbone', 1, 4, strftime('%s','now'), strftime('%s','now')),
  ('Google Ads: Chevron', 1, 5, strftime('%s','now'), strftime('%s','now')),
  ('Google Ads: Timber Repairs', 1, 6, strftime('%s','now'), strftime('%s','now')),
  ('Phone', 1, 7, strftime('%s','now'), strftime('%s','now')),
  ('Referral', 1, 8, strftime('%s','now'), strftime('%s','now')),
  ('Repeat client', 1, 9, strftime('%s','now'), strftime('%s','now')),
  ('Builder', 1, 10, strftime('%s','now'), strftime('%s','now')),
  ('Insurance work order', 1, 11, strftime('%s','now'), strftime('%s','now')),
  ('Walk-in showroom', 1, 12, strftime('%s','now'), strftime('%s','now')),
  ('Website', 1, 13, strftime('%s','now'), strftime('%s','now')),
  ('Other', 1, 14, strftime('%s','now'), strftime('%s','now')),
  ('Unknown (before tracking)', 1, 15, strftime('%s','now'), strftime('%s','now'));

-- The six live pages. Form keys are what each page posts to. Conversion labels go in once Damien sends them.
INSERT INTO landing_pages (url, lead_source, client_type, tags, follow_up_on, form_key, conversion_label, timber, active, created_at, updated_at) VALUES
  ('medical-gpclinic.terraflooring.com.au', 'Google Ads: Medical & GP Clinic', 'healthcare', '[]', 1, 'medical-gpclinic', '', 0, 1, strftime('%s','now'), strftime('%s','now')),
  ('pharmacy.terraflooring.com.au', 'Google Ads: Pharmacy', 'healthcare', '[]', 1, 'pharmacy', '', 0, 1, strftime('%s','now'), strftime('%s','now')),
  ('commercial-kitchen.terraflooring.com.au', 'Google Ads: Commercial Kitchen', 'commercial', '[]', 1, 'commercial-kitchen', '', 0, 1, strftime('%s','now'), strftime('%s','now')),
  ('herringbone.terraflooring.com.au', 'Google Ads: Herringbone', 'homeowner', '[]', 1, 'herringbone', '', 0, 1, strftime('%s','now'), strftime('%s','now')),
  ('chevron.terraflooring.com.au', 'Google Ads: Chevron', 'homeowner', '[]', 1, 'chevron', '', 0, 1, strftime('%s','now'), strftime('%s','now')),
  ('timberrepairs.terraflooring.com.au', 'Google Ads: Timber Repairs', 'homeowner', '["Timber repair"]', 1, 'timberrepairs', 'AW-859821500/KRslCK6znpIcELyr_5kD', 1, 1, strftime('%s','now'), strftime('%s','now'));

-- Marc's skill. One person, prices from photos, paid the price he quotes.
INSERT INTO skills (name, group_name, default_crew_size, min_crew, recommended_crew, production_rate, production_unit, fixed_days, min_completion_photos, sort_order, active, created_at, updated_at)
  SELECT 'Timber repair', 'timber', 1, 1, 1, NULL, 'each', 0, 4, (SELECT coalesce(max(sort_order), 0) + 1 FROM skills), 1, strftime('%s','now'), strftime('%s','now')
  WHERE NOT EXISTS (SELECT 1 FROM skills WHERE lower(name) = 'timber repair');
