-- Staff invites (notes 18.55, 17 Oct). One new table. Nothing existing is changed.
CREATE TABLE IF NOT EXISTS invites (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE cascade,
  user_id text NOT NULL,
  token_hash text NOT NULL,
  channel text NOT NULL,
  sent_to text DEFAULT '' NOT NULL,
  status text DEFAULT 'sending' NOT NULL,
  detail text,
  sent_by_name text DEFAULT '' NOT NULL,
  expires_at integer NOT NULL,
  used_at integer,
  voided_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS invites_token_hash_unique ON invites (token_hash);
CREATE INDEX IF NOT EXISTS invites_profile_idx ON invites (profile_id);
