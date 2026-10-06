-- Quoting slice 4 (client bundles) and the quote agent's chat history.
-- Additive only. Applied by script after a full backup, never through db:push.

-- combined = one bundle for the whole quote. split = one bundle per floor type,
-- plus one for the non-floor work.
ALTER TABLE quotes ADD COLUMN bundle_mode text NOT NULL DEFAULT 'combined';

-- Which bundle a line belongs to in split mode. Null = worked out from the
-- product category and line kind.
ALTER TABLE quote_items ADD COLUMN floor_category text;

-- The client facing wording for each bundle. The client only ever sees these:
-- a title, the wording and the bundle total. Never qty, rates or line prices.
CREATE TABLE IF NOT EXISTS quote_bundles (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE cascade,
  -- 'all' in combined mode, else a floor category or 'extras'.
  bundle_key text NOT NULL,
  title text NOT NULL DEFAULT '',
  wording text NOT NULL DEFAULT '',
  -- ai · manual · '' (never written)
  wording_source text NOT NULL DEFAULT '',
  -- The lines the wording was written for. Differs from the current lines = stale.
  line_signature text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS quote_bundles_quote_key_uq ON quote_bundles (quote_id, bundle_key);

-- Quote agent chat, saved per quote.
CREATE TABLE IF NOT EXISTS quote_agent_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE cascade,
  user_id text,
  user_name text NOT NULL DEFAULT '',
  -- user · assistant
  role text NOT NULL,
  content text NOT NULL DEFAULT '',
  -- JSON list of proposed changes the user can Apply. Null = plain answer.
  proposal text,
  applied_at integer,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS quote_agent_messages_quote_idx ON quote_agent_messages (quote_id, id);
