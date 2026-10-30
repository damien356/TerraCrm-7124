-- Quote sent by email and SMS (Damien, 30 Oct, after 188048).
-- One new table. Nothing existing is changed or removed, and no existing quote
-- is put into it, so nothing old gets a text.
CREATE TABLE IF NOT EXISTS quote_sends (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE cascade,
  send_key text NOT NULL,
  quote_total real DEFAULT 0 NOT NULL,
  kind text DEFAULT 'first' NOT NULL,
  by_name text DEFAULT '' NOT NULL,
  email_to text,
  email_status text DEFAULT 'skipped' NOT NULL,
  email_detail text,
  email_message_id integer,
  email_at integer,
  email_json text,
  sms_to text,
  sms_status text DEFAULT 'skipped' NOT NULL,
  sms_detail text,
  sms_message_id integer,
  sms_provider_id text,
  sms_at integer,
  sms_json text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS quote_sends_send_key_unique ON quote_sends (send_key);
CREATE INDEX IF NOT EXISTS quote_sends_quote_idx ON quote_sends (quote_id, created_at);
