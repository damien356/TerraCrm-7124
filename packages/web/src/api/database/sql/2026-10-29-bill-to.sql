-- Bill to on quotes and deposit % from the payer's card (notes 18.54, 16 Oct). Four new columns. Nothing existing is changed.
ALTER TABLE quotes ADD COLUMN deposit_source text DEFAULT 'none' NOT NULL;
ALTER TABLE quotes ADD COLUMN bill_to_type text;
ALTER TABLE quotes ADD COLUMN bill_to_contact_id integer REFERENCES contacts(id) ON DELETE set null;
ALTER TABLE quotes ADD COLUMN bill_to_company_id integer REFERENCES companies(id) ON DELETE set null;
