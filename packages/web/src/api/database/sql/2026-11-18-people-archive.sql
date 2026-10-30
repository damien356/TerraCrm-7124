-- Archive and delete people (Damien, 30 Oct).
-- New columns only. Nobody is archived, deleted or changed by this file, except
-- that Damien's own login is marked as the main admin.
ALTER TABLE profiles ADD COLUMN is_main_admin integer DEFAULT false NOT NULL;
ALTER TABLE profiles ADD COLUMN can_restore_people integer DEFAULT false NOT NULL;
ALTER TABLE profiles ADD COLUMN archived_at integer;
ALTER TABLE profiles ADD COLUMN archived_by_name text;
ALTER TABLE installers ADD COLUMN archived_by_name text;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_one_main_admin ON profiles (is_main_admin) WHERE is_main_admin = 1;
UPDATE profiles SET is_main_admin = 1
  WHERE lower(email) = 'damien@terraflooring.com.au' AND role = 'admin'
    AND NOT EXISTS (SELECT 1 FROM profiles p2 WHERE p2.is_main_admin = 1);
