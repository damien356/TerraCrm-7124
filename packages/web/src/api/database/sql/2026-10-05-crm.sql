-- People, access levels, supervisors, discount approval, line tags and price history.
-- From the CRM branch handover, section 7. Additive. Applied by script after a full
-- backup, never through db:push. The runner skips a column that already exists.

-- 7.1 Bulk specials
ALTER TABLE product_specials ADD COLUMN pass_on_to_customer integer NOT NULL DEFAULT 0;

-- 7.2 Access and discount approval
ALTER TABLE profiles ADD COLUMN phone text;
ALTER TABLE profiles ADD COLUMN can_see_costs integer NOT NULL DEFAULT 0;
ALTER TABLE installers ADD COLUMN archived_at integer;
ALTER TABLE quotes ADD COLUMN discount_approved_percent real NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN discount_approved_by text;
ALTER TABLE quotes ADD COLUMN discount_approved_at integer;
ALTER TABLE quote_items ADD COLUMN list_unit_price real;
UPDATE profiles SET role = 'office' WHERE name IN ('Admin Test','QA Board Check');

-- 7.3 Supervisors
ALTER TABLE quotes ADD COLUMN supervisor_contact_id integer REFERENCES contacts(id) ON DELETE SET NULL;

-- 7.4 Line tags and history
ALTER TABLE quote_items ADD COLUMN line_type text NOT NULL DEFAULT 'material';
UPDATE quote_items SET line_type = 'labour' WHERE kind IN ('labour','prep','removal');
CREATE TABLE IF NOT EXISTS quote_price_history (
  id integer PRIMARY KEY AUTOINCREMENT,
  quote_id integer REFERENCES quotes(id) ON DELETE SET NULL,
  quote_item_id integer,
  product_id integer REFERENCES products(id) ON DELETE SET NULL,
  contact_id integer REFERENCES contacts(id) ON DELETE SET NULL,
  company_id integer REFERENCES companies(id) ON DELETE SET NULL,
  supervisor_contact_id integer REFERENCES contacts(id) ON DELETE SET NULL,
  unit text NOT NULL DEFAULT 'm2',
  unit_price real NOT NULL,
  quoted_by_name text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'quote',
  quoted_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS qph_company_product_idx ON quote_price_history(company_id, product_id);
CREATE INDEX IF NOT EXISTS qph_contact_product_idx ON quote_price_history(contact_id, product_id);

-- 7.5 Backfill from quotes that went out
INSERT INTO quote_price_history (
  quote_id, quote_item_id, product_id, contact_id, company_id,
  supervisor_contact_id, unit, unit_price, quoted_by_name, source, quoted_at
)
SELECT q.id, i.id, i.product_id, q.contact_id, q.company_id,
       q.supervisor_contact_id, i.unit, i.unit_price, '', 'backfill',
       COALESCE(q.sent_at, q.created_at)
FROM quote_items i JOIN quotes q ON q.id = i.quote_id
WHERE i.product_id IS NOT NULL AND i.unit_price > 0
  AND (q.sent_at IS NOT NULL OR q.status IN ('sent','accepted'))
  AND NOT EXISTS (
    SELECT 1 FROM quote_price_history h WHERE h.quote_item_id = i.id
  );

-- "Make a new version" keeps the quote number and adds 1 to the version.
-- Live only allowed one row per number, so new versions failed. Unique on
-- number + version instead. Added first, then the old rule is dropped.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_number_version_unique ON quotes (number, version);
DROP INDEX IF EXISTS quotes_number_unique;
