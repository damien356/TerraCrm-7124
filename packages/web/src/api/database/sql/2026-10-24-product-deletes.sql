-- 15 Oct: delete products from Settings, Price list, with a log and Undo last delete.
CREATE TABLE IF NOT EXISTS product_deletes (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  actor_name text DEFAULT '' NOT NULL,
  actor_user_id text,
  deleted integer DEFAULT 0 NOT NULL,
  hidden integer DEFAULT 0 NOT NULL,
  status text DEFAULT 'applied' NOT NULL,
  undone_at integer,
  undone_by text DEFAULT '' NOT NULL,
  undo_note text DEFAULT '' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE TABLE IF NOT EXISTS product_delete_rows (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  delete_id integer NOT NULL REFERENCES product_deletes(id) ON DELETE cascade,
  product_id integer NOT NULL,
  action text NOT NULL,
  name text DEFAULT '' NOT NULL,
  reason text DEFAULT '' NOT NULL,
  was_active integer DEFAULT false NOT NULL,
  snapshot text DEFAULT '{}' NOT NULL
);
CREATE INDEX IF NOT EXISTS product_delete_rows_delete_idx ON product_delete_rows (delete_id);
