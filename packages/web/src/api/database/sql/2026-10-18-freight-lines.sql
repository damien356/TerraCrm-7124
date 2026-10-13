-- Supplier freight and charges as their own internal quote lines (notes 18.33).
-- A line with charge_supplier_id set is a supplier charge worked out from that
-- supplier's rules. charge_key says which rule. charge_typed is set once
-- someone types over it, and recalc then leaves it as typed.
-- The client never sees these lines: their sell is spread into that
-- supplier's product lines on every client copy.
ALTER TABLE quote_items ADD COLUMN charge_supplier_id integer;
ALTER TABLE quote_items ADD COLUMN charge_key text;
ALTER TABLE quote_items ADD COLUMN charge_typed integer NOT NULL DEFAULT 0;
