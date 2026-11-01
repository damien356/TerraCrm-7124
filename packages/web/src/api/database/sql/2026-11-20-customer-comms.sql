-- Customer communications (Damien, 31 Oct). One panel per job for quote
-- follow-ups, care guides and review requests. Every recipient is approved
-- before anything goes.
--
-- Data changes at the bottom: live quote follow-ups and care members move to
-- Awaiting approval, so nothing already queued goes without a person checking
-- who it is for. Nothing is deleted.
ALTER TABLE jobs ADD COLUMN builder_ref text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE jobs ADD COLUMN direct_contact_ok integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE jobs ADD COLUMN direct_contact_ok_by text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE jobs ADD COLUMN direct_contact_ok_at integer;
--> statement-breakpoint
ALTER TABLE quote_followups ADD COLUMN approved_at integer;
--> statement-breakpoint
ALTER TABLE quote_followups ADD COLUMN approved_by_name text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE quote_followups ADD COLUMN approval_snapshot text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE quote_followups ADD COLUMN pause_profile_id integer REFERENCES profiles(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE quote_followups ADD COLUMN pause_name text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE quote_followups ADD COLUMN review_date text;
--> statement-breakpoint
ALTER TABLE quote_followups ADD COLUMN resume_approved integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE care_members ADD COLUMN approved_at integer;
--> statement-breakpoint
ALTER TABLE care_members ADD COLUMN approved_by_name text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE care_members ADD COLUMN approval_snapshot text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE care_members ADD COLUMN awaiting_reason text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS review_requests (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE cascade,
  contact_id integer REFERENCES contacts(id) ON DELETE set null,
  role text DEFAULT '' NOT NULL,
  channel text DEFAULT 'email' NOT NULL,
  to_address text DEFAULT '' NOT NULL,
  status text DEFAULT 'awaiting_approval' NOT NULL,
  reason text DEFAULT '' NOT NULL,
  max_sends integer DEFAULT 2 NOT NULL,
  sent_count integer DEFAULT 0 NOT NULL,
  next_kind text DEFAULT 'initial' NOT NULL,
  next_send_at integer,
  what text DEFAULT '' NOT NULL,
  last_sent_at integer,
  last_error text DEFAULT '' NOT NULL,
  approved_at integer,
  approved_by_name text DEFAULT '' NOT NULL,
  approval_snapshot text DEFAULT '' NOT NULL,
  pause_profile_id integer REFERENCES profiles(id) ON DELETE set null,
  pause_name text DEFAULT '' NOT NULL,
  review_date text,
  replies_seen_at integer,
  received_at integer,
  received_by_name text DEFAULT '' NOT NULL,
  declined_at integer,
  declined_by_name text DEFAULT '' NOT NULL,
  sending_at integer,
  created_by_name text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_job_uq ON review_requests (job_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS review_requests_contact_idx ON review_requests (contact_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS comms_events (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer REFERENCES jobs(id) ON DELETE cascade,
  kind text NOT NULL,
  ref_id integer,
  event text NOT NULL,
  detail text DEFAULT '' NOT NULL,
  channel text DEFAULT '' NOT NULL,
  to_address text DEFAULT '' NOT NULL,
  send_id integer REFERENCES sends(id) ON DELETE set null,
  message_id integer REFERENCES messages(id) ON DELETE set null,
  by_name text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS comms_events_job_idx ON comms_events (job_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS comms_events_ref_idx ON comms_events (kind, ref_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS care_guide_sends (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id integer NOT NULL REFERENCES jobs(id) ON DELETE cascade,
  contact_id integer REFERENCES contacts(id) ON DELETE set null,
  code text NOT NULL,
  to_address text NOT NULL,
  role text DEFAULT '' NOT NULL,
  subject text DEFAULT '' NOT NULL,
  body text DEFAULT '' NOT NULL,
  status text DEFAULT 'sending' NOT NULL,
  message_id integer REFERENCES messages(id) ON DELETE set null,
  error text DEFAULT '' NOT NULL,
  request_key text NOT NULL,
  by_name text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS care_guide_sends_request_uq ON care_guide_sends (request_key, code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS care_guide_sends_job_idx ON care_guide_sends (job_id);
--> statement-breakpoint
-- The review request template (id 1) had "if you're happy with it" wording and
-- a [review link] placeholder. It becomes the plain ask Damien approved.
-- {{job_phrase}} and {{review_link}} are filled at send time.
UPDATE email_templates SET subject = 'How did we go, {{first_name}}?', body = 'Hi {{first_name}},

Thanks for choosing Terra Flooring for {{job_phrase}}. If you''d like to share your experience, we''d appreciate a review. It takes about a minute: {{review_link}}

If there''s anything you''d like us to look at, just reply to this email.

Thanks, Damien, Terra Flooring' WHERE id = 1 AND name = 'Review request';
--> statement-breakpoint
-- Old "Waiting: ..." notes on steps that were moved read like a problem today.
-- They say what they are: why the date moved, back then.
UPDATE quote_followup_steps SET reason = 'Moved to this date earlier. ' || substr(reason, 10) WHERE status = 'scheduled' AND reason LIKE 'Waiting: %';
--> statement-breakpoint
UPDATE quote_followups SET status = 'awaiting_approval', reason = 'Check who gets these and approve them. Nothing goes until then.' WHERE status = 'active';
--> statement-breakpoint
UPDATE care_members SET status = 'awaiting_approval', awaiting_reason = 'Joined before approvals. Check the person, the guides and the dates. Emails already due are never sent late.' WHERE status = 'active';
