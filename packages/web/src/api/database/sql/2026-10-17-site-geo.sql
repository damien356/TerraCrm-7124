ALTER TABLE sites ADD COLUMN lat real;
ALTER TABLE sites ADD COLUMN lng real;
ALTER TABLE sites ADD COLUMN place_id text;
ALTER TABLE sites ADD COLUMN geo_source text NOT NULL DEFAULT '';
