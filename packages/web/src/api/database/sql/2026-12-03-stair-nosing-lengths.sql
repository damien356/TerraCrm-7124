-- Riverhill stair nosing lengths, corrected by Damien (7 Nov 2026):
-- "Go 1.540m and 1.82m as the product says".
-- 5881 (Elegant Hybrid 6.5mm) 1.9 m -> 1.54 m, 5886 (Elegant Hybrid 9.5mm) 2.4 m -> 1.82 m,
-- matching their supplier size text (1540x115x38 and 1820x115x38).
-- Needs 2026-12-01-skirting-labour.sql first (already live). Does not need 2026-12-02.
-- Not touched: prices, units, names, SKUs, sizes, quotes and quote lines (no quote line uses
-- either product). Each step only runs while the row still holds the old length, so running
-- the file twice changes nothing the second time.
UPDATE products SET piece_length_m = 1.54, notes = replace(notes, 'Length 1.9 m (confirmed by Damien, 7 Nov 2026).', 'Length 1.54 m, as the supplier size (corrected by Damien, 7 Nov 2026).'), updated_at = cast(strftime('%s','now') as integer) WHERE id = 5881 AND supplier = 'Riverhill' AND range = 'Elegant Hybrid 6.5mm' AND sku = 'Stair-nosing' AND piece_length_m = 1.9;
UPDATE products SET piece_length_m = 1.82, notes = replace(notes, 'Length 2.4 m (confirmed by Damien, 7 Nov 2026).', 'Length 1.82 m, as the supplier size (corrected by Damien, 7 Nov 2026).'), updated_at = cast(strftime('%s','now') as integer) WHERE id = 5886 AND supplier = 'Riverhill' AND range = 'Elegant Hybrid 9.5mm' AND sku = 'Stair-nosing' AND piece_length_m = 2.4;
