-- Damien's answers to the last open catalog items, and the skirting labour (7 Nov 2026).
-- Needs 2026-11-28, 2026-11-29 and 2026-11-30 first.
--
-- 1. Lengths he confirmed, each on its own record:
--    Big Panda L Angle 8547: 2.4 m only.
--    Dunlop Stairnose 9868: 2.4 m (already stored; the 14.4 m check note is replaced).
--    Riverhill stair nosings: 5881 (6.5mm) 1.9 m, 5886 (9.5mm) 2.4 m, in the order
--    he gave them. Their size text (1540 and 1820) is the supplier listing and is
--    left as it is. Stair nosings stay accessories: no trim install.
-- 2. Two new rate book items, next to Skirting removal and refit (same trade,
--    same skill, same 50% markup):
--    121 Install new skirting, $10.00 a lm installer rate.
--    122 Skirting removal only, $5.00 a lm installer rate.
--    The code puts Install new skirting under a Skirting product (the Mitre 10
--    pine mouldings) at the lm installed. Removal only is picked by hand.
--
-- Not touched: prices, units, names, SKUs, sizes, quotes, quote lines, orders,
-- jobs, existing rate items and rates. Every step only runs on a row still in
-- its expected state, so running the file twice changes nothing the second time.

-- 1. Lengths.
UPDATE products SET piece_length_m = 2.4, notes = coalesce(notes, '') || ' · Length 2.4 m only (confirmed by Damien, 7 Nov 2026).', updated_at = cast(strftime('%s','now') as integer) WHERE id = 8547 AND supplier = 'Big Panda Flooring' AND range = 'L Angle Trim' AND piece_length_m IS NULL;
UPDATE products SET notes = replace(notes, '(PDF says 14.4 m/length - check)', '(2.4 m length confirmed by Damien, 7 Nov 2026)'), updated_at = cast(strftime('%s','now') as integer) WHERE id = 9868 AND range = 'Stairnose Riverfields 8mm Laminate' AND sku = '850018' AND piece_length_m = 2.4 AND notes LIKE '%(PDF says 14.4 m/length - check)%';
UPDATE products SET piece_length_m = 1.9, notes = coalesce(notes, '') || ' · Length 1.9 m (confirmed by Damien, 7 Nov 2026).', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5881 AND supplier = 'Riverhill' AND range = 'Elegant Hybrid 6.5mm' AND sku = 'Stair-nosing' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, notes = coalesce(notes, '') || ' · Length 2.4 m (confirmed by Damien, 7 Nov 2026).', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5886 AND supplier = 'Riverhill' AND range = 'Elegant Hybrid 9.5mm' AND sku = 'Stair-nosing' AND piece_length_m IS NULL;

-- 2. Skirting labour.
INSERT INTO labour_rate_items (id, skill_id, name, group_name, kind, unit, notes, sort_order, active, created_at, updated_at, markup_percent, site_prep, whole_group)
SELECT 121, 24, 'Install new skirting', 'trades', 'work', 'lm', 'Fitting new skirting boards (the boards go on their own supply line). Damien, 7 Nov 2026.', 66, 1, cast(strftime('%s','now') as integer), cast(strftime('%s','now') as integer), 50, 0, 0
WHERE NOT EXISTS (SELECT 1 FROM labour_rate_items WHERE id = 121 OR lower(name) = 'install new skirting');
INSERT INTO labour_rate_items (id, skill_id, name, group_name, kind, unit, notes, sort_order, active, created_at, updated_at, markup_percent, site_prep, whole_group)
SELECT 122, 24, 'Skirting removal only', 'trades', 'work', 'lm', 'Existing skirting taken off, not refitted. Damien, 7 Nov 2026.', 66, 1, cast(strftime('%s','now') as integer), cast(strftime('%s','now') as integer), 50, 0, 0
WHERE NOT EXISTS (SELECT 1 FROM labour_rate_items WHERE id = 122 OR lower(name) = 'skirting removal only');
INSERT INTO labour_rates (item_id, installer_id, amount, minimum_charge, effective_from, effective_to, note, created_by_name, created_at, updated_at)
SELECT 121, NULL, 10, NULL, '2026-11-07', NULL, 'Installer rate from Damien, 7 Nov 2026', 'Damien Lacey', cast(strftime('%s','now') as integer), cast(strftime('%s','now') as integer)
WHERE EXISTS (SELECT 1 FROM labour_rate_items WHERE id = 121 AND name = 'Install new skirting')
  AND NOT EXISTS (SELECT 1 FROM labour_rates WHERE item_id = 121 AND installer_id IS NULL);
INSERT INTO labour_rates (item_id, installer_id, amount, minimum_charge, effective_from, effective_to, note, created_by_name, created_at, updated_at)
SELECT 122, NULL, 5, NULL, '2026-11-07', NULL, 'Installer rate from Damien, 7 Nov 2026', 'Damien Lacey', cast(strftime('%s','now') as integer), cast(strftime('%s','now') as integer)
WHERE EXISTS (SELECT 1 FROM labour_rate_items WHERE id = 122 AND name = 'Skirting removal only')
  AND NOT EXISTS (SELECT 1 FROM labour_rates WHERE item_id = 122 AND installer_id IS NULL);
