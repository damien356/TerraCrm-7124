-- Quoting slice 2: deposit defaults and per line markup. Additive only.
-- Applied by script after a full backup, never through db:push.
-- Null means "use the default": 0% for a builder company, 50% for anyone else.
ALTER TABLE companies ADD COLUMN deposit_percent real;
ALTER TABLE contacts ADD COLUMN deposit_percent real;
-- The markup % a line was priced at. Null on older lines, which show the
-- markup worked out from cost and sell instead.
ALTER TABLE quote_items ADD COLUMN markup_percent real;
