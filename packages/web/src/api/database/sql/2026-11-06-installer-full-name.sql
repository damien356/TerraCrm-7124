-- Notes 18.66: an installer's full legal name, kept apart from the short name he goes by. Add a column only.
ALTER TABLE installers ADD COLUMN full_name text;
