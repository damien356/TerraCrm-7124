-- Fix list 11 Oct, item 14 and answer 5: supplier freight built into the
-- material line's price. The part of unit_cost that is freight and charges.
ALTER TABLE quote_items ADD COLUMN freight_unit_cost real;
