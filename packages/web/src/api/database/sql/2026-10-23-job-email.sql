-- Job email thread (spec 15 Oct). Email from inside the job, replies filed on the job.
-- New columns on messages and mail_accounts, and one new table. Nothing existing is changed.
-- See api/lib/job-mail.ts, api/lib/mail-replies.ts and PROJECT_NOTES section 18.40.

-- Which Gmail mailbox an email went out of or came into, and Gmail's own ids,
-- so a reply threads in Gmail and an email is never filed twice.
ALTER TABLE messages ADD mailbox text;
ALTER TABLE messages ADD gmail_id text;
ALTER TABLE messages ADD gmail_thread_id text;
-- "Repair R188000-1" or "Variation V188000-01" on the parent job's thread.
ALTER TABLE messages ADD label text;
-- An out of office or automatic reply. Logged on the job, never a task.
ALTER TABLE messages ADD auto_reply integer DEFAULT 0 NOT NULL;
CREATE INDEX messages_gmail_thread_idx ON messages (gmail_thread_id);
CREATE INDEX messages_gmail_id_idx ON messages (gmail_id);

-- The reply pass keeps its own place in each mailbox, apart from invoice reading.
ALTER TABLE mail_accounts ADD replies_synced_through integer;

-- Every email the reply pass has looked at, so nothing is filed twice.
CREATE TABLE mail_replies (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  account_id integer NOT NULL REFERENCES mail_accounts(id) ON DELETE cascade,
  gmail_id text NOT NULL,
  thread_id text,
  from_address text DEFAULT '' NOT NULL,
  subject text DEFAULT '' NOT NULL,
  received_at integer,
  status text DEFAULT 'filed' NOT NULL,
  how text DEFAULT '' NOT NULL,
  note text DEFAULT '' NOT NULL,
  message_id integer REFERENCES messages(id) ON DELETE set null,
  attempts integer DEFAULT 1 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX mail_replies_account_gmail_unique ON mail_replies (account_id, gmail_id);
CREATE INDEX mail_replies_status_idx ON mail_replies (status);
