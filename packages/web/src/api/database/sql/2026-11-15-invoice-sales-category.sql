-- Task H (Damien, 29 Oct): a sales category on each invoice, and one row per payment.
-- Adds two invoice columns and one table. Nothing existing is removed.
-- customer goes to Xero sales account 200, installer_materials to 204.
ALTER TABLE invoices ADD COLUMN sales_category text DEFAULT 'customer' NOT NULL;
ALTER TABLE invoices ADD COLUMN xero_sales_account text;

-- Invoices raised by New materials invoice before this column, on its internal
-- supply only job. Only ones not yet in Xero: anything already sent keeps what Xero has.
UPDATE invoices SET sales_category = 'installer_materials'
WHERE xero_invoice_id IS NULL
  AND job_id IN (SELECT id FROM jobs WHERE source = 'Installer (materials)');

CREATE TABLE IF NOT EXISTS invoice_payments (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE cascade,
  amount real NOT NULL,
  method text NOT NULL,
  paid_on integer NOT NULL,
  by_name text DEFAULT '' NOT NULL,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx ON invoice_payments (invoice_id);
