-- Job contacts: tags per person per job, a "when to contact" note, the company
-- the person acted for, and the same list on quotes.
-- Additive only. Applied by script after a full backup, never through db:push.
-- The old `role` column stays, holding the first tag, so older readers keep working.

-- JSON list of tags: owner · tenant · supervisor · property_manager ·
-- builder_contact · accounts · other. A person can hold several on one job.
ALTER TABLE job_contacts ADD COLUMN tags text NOT NULL DEFAULT '[]';
-- When and how to reach this person on this job ("after 3pm", "text first").
ALTER TABLE job_contacts ADD COLUMN when_to_contact text;
-- The company they were acting for when added. Keeps referral credit with
-- that company even if the person later moves.
ALTER TABLE job_contacts ADD COLUMN acted_for_company_id integer REFERENCES companies(id) ON DELETE SET NULL;

-- Show to Crew: chosen job by job, any tag (Supervisor included). Starts on for
-- exactly the people Crew could see before (Site access or Decision-maker, not
-- the supervisor), so nothing changes for Crew on day one.
ALTER TABLE job_contacts ADD COLUMN show_to_crew integer NOT NULL DEFAULT false;

-- Old roles become tags. A plain job_contact is the Owner on a private job and
-- Other on a company job. Referrer becomes Other.
UPDATE job_contacts SET tags = json_array(
  CASE role
    WHEN 'job_contact' THEN CASE WHEN (SELECT company_id FROM jobs WHERE jobs.id = job_contacts.job_id) IS NULL THEN 'owner' ELSE 'other' END
    WHEN 'property_manager' THEN 'property_manager'
    WHEN 'tenant' THEN 'tenant'
    WHEN 'supervisor' THEN 'supervisor'
    WHEN 'owner' THEN 'owner'
    WHEN 'accounts' THEN 'accounts'
    ELSE 'other'
  END
) WHERE tags = '[]';
UPDATE job_contacts SET role = json_extract(tags, '$[0]');
UPDATE job_contacts SET show_to_crew = 1
  WHERE (on_site_contact = 1 OR can_approve_quote = 1)
    AND NOT EXISTS (SELECT 1 FROM json_each(job_contacts.tags) WHERE json_each.value = 'supervisor');
-- Tenants start shown to crew (Damien, 7 Oct).
UPDATE job_contacts SET show_to_crew = 1
  WHERE EXISTS (SELECT 1 FROM json_each(job_contacts.tags) WHERE json_each.value = 'tenant');

-- One row per person per job. Live has no person twice on one job (checked
-- 7 Oct 2026); the dry run script merges any it finds before this runs.
DROP INDEX IF EXISTS job_contact_unique;
CREATE UNIQUE INDEX IF NOT EXISTS job_contact_person_uq ON job_contacts (job_id, contact_id);

-- The same list on a quote. Copied onto the job when the quote is accepted or
-- converted, and onto the new version when a quote is revised.
CREATE TABLE IF NOT EXISTS quote_contacts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE cascade,
  contact_id integer NOT NULL REFERENCES contacts(id) ON DELETE cascade,
  tags text NOT NULL DEFAULT '[]',
  -- Decision-maker: approves colour, product and sign-off.
  can_approve_quote integer NOT NULL DEFAULT false,
  -- Site access: the person Crew rings to get in.
  on_site_contact integer NOT NULL DEFAULT false,
  receives_sms integer NOT NULL DEFAULT false,
  receives_email integer NOT NULL DEFAULT false,
  -- Show to Crew, carried onto the job.
  show_to_crew integer NOT NULL DEFAULT false,
  when_to_contact text,
  acted_for_company_id integer REFERENCES companies(id) ON DELETE SET NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS quote_contact_person_uq ON quote_contacts (quote_id, contact_id);
