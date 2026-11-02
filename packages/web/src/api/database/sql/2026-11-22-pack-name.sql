-- Pack name on products (Damien, 2 Nov). What one pack is called: Box, Sheet,
-- Carton or Bag. Every product on file stays Box, so nothing sold today
-- changes. A sheet, carton or bag product is ordered and counted in whole
-- packs ("10 sheets @ $15.50").
-- client_packs: per quote line, show the client the pack count (10 sheets)
-- instead of the m2. 0 = m2, the default.
-- Additive only. Nothing is deleted and no history changes.
ALTER TABLE products ADD COLUMN pack_name text NOT NULL DEFAULT 'box';
--> statement-breakpoint
ALTER TABLE quote_items ADD COLUMN client_packs integer NOT NULL DEFAULT 0;
