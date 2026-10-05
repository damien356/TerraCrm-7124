# Quoting and pricing, slice 1: price history and Material/Labour tag

Run this on the live DB before publishing.

```sql
ALTER TABLE quote_items ADD COLUMN line_type text NOT NULL DEFAULT 'material';
UPDATE quote_items SET line_type = 'labour' WHERE kind IN ('labour','prep','removal');

CREATE TABLE quote_price_history (
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
CREATE INDEX qph_company_product_idx ON quote_price_history(company_id, product_id);
CREATE INDEX qph_contact_product_idx ON quote_price_history(contact_id, product_id);

-- Backfill from quotes already sent (one row per product line)
INSERT INTO quote_price_history (quote_id, quote_item_id, product_id, contact_id, company_id, supervisor_contact_id, unit, unit_price, quoted_by_name, source, quoted_at)
SELECT q.id, i.id, i.product_id, q.contact_id, q.company_id, q.supervisor_contact_id, i.unit, i.unit_price, '', 'backfill',
       COALESCE(q.sent_at, q.created_at)
FROM quote_items i JOIN quotes q ON q.id = i.quote_id
WHERE i.product_id IS NOT NULL AND i.unit_price > 0
  AND q.status IN ('sent','accepted','converted');
```

(If the backfill fails on a column or status name, skip it. The table works without it.)

Plain English:
- Every line on a quote is now tagged Material or Labour. Tap the tag under the type to flip it.
- When a quote is sent, its product prices are saved to a permanent history, for the customer, company and supervisor.
- This is groundwork for the "you quoted less last time" warning.
