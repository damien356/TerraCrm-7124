-- Steps 1 to 3 (20 Oct): AI log and tray, supplier PO helper, invoice labels.
-- One new table and three new columns. No existing row is changed by this file.
CREATE TABLE IF NOT EXISTS ai_actions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  agent text NOT NULL,
  kind text NOT NULL,
  status text DEFAULT 'done' NOT NULL,
  title text NOT NULL,
  detail text DEFAULT '' NOT NULL,
  path text,
  job_id integer REFERENCES jobs(id) ON DELETE set null,
  supplier_id integer REFERENCES suppliers(id) ON DELETE set null,
  po_id integer REFERENCES purchase_orders(id) ON DELETE set null,
  invoice_id integer REFERENCES supplier_invoices(id) ON DELETE set null,
  request_id integer REFERENCES invoice_requests(id) ON DELETE set null,
  data text DEFAULT '{}' NOT NULL,
  resolved_at integer,
  resolved_by text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_actions_status_idx ON ai_actions (status, created_at);
CREATE INDEX IF NOT EXISTS ai_actions_job_idx ON ai_actions (job_id);
CREATE INDEX IF NOT EXISTS ai_actions_po_idx ON ai_actions (po_id);
ALTER TABLE suppliers ADD COLUMN no_po_needed integer DEFAULT false NOT NULL;
ALTER TABLE invoice_requests ADD COLUMN job_id integer REFERENCES jobs(id) ON DELETE set null;
ALTER TABLE invoice_requests ADD COLUMN po_id integer REFERENCES purchase_orders(id) ON DELETE set null;
CREATE INDEX IF NOT EXISTS invoice_requests_job_idx ON invoice_requests (job_id);
