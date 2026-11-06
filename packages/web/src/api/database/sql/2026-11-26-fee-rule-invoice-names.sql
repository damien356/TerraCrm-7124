-- Invoice wording on supplier charges (Karndean invoice CI155812, 6 Nov).
-- Other names a supplier prints for the same charge on an invoice, comma
-- separated: Karndean print FUELSURCH, RESILOOP and HANDLING. Invoice matching
-- reads it to tie an invoice line to the right charge. Empty on every row, so
-- nothing changes until a name is put in.
-- Additive only. Nothing is deleted and no history changes.
ALTER TABLE supplier_fee_rules ADD COLUMN invoice_names text NOT NULL DEFAULT '';
