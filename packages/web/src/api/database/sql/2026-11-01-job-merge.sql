-- Job merge (notes 18.48). Three new columns on jobs and one index. Nothing existing is changed.
ALTER TABLE jobs ADD COLUMN merged_into_job_id integer REFERENCES jobs(id) ON DELETE set null;
ALTER TABLE jobs ADD COLUMN merged_at integer;
ALTER TABLE jobs ADD COLUMN merged_by_name text;
CREATE INDEX IF NOT EXISTS jobs_merged_idx ON jobs (merged_into_job_id);
