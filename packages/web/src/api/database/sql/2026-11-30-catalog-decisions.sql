-- Catalog decisions (Damien's returned exceptions workbook, 7 Nov 2026).
-- Catalog data only. Needs 2026-11-28-quote-defaults.sql and then
-- 2026-11-29-trim-lengths-vinyl-class.sql first (the vinyl step here only
-- touches rows that file has marked Sold as Broadloom).
--
-- 1. Piece lengths Damien confirmed, each on its own record (one physical
--    length, not a carton and not labour). Variants matched by the record's
--    own name, SKU and size. Not touched: Big Panda 8547 (one record, two
--    lengths), Dunlop stairnose 9868, Riverhill stair nosings 5881 and 5886.
-- 2. Item type (category) from the record's own SKU/name, using the price
--    book's existing Trims, Scotia and Skirting categories, so the finished
--    trims and scotia bring Install trims/scotia and the Mitre 10 pine
--    mouldings are new skirting (no trim install, no skirting removal).
--    Base plates and the base channel stay as they are: inserts, no install.
-- 3. Dunlop T-Trim Riverfields: the stored 2.4 m stays; the "60 m/length -
--    check" note is replaced with Damien's confirmation.
-- 4. Vinyl type (tier) by supplier and range: Commercial Sheet or Domestic
--    Sheet, only on roll goods whose tier is blank or plain "Sheet Vinyl".
--    Safety Sheet rows are left as they are.
--
-- Not touched: prices, units, names, SKUs, sizes, quotes, quote lines,
-- orders, jobs. Every step only runs on a row still in its expected state,
-- so running the file twice changes nothing the second time.

-- 1. Lengths.
-- Floor Distributors 9478, Designer Profile Scotia Timber (per lm): 2.4 m.
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 9478 AND range = 'Designer Profile Scotia Timber' AND sku = 'DPTS17BBT' AND piece_length_m IS NULL;
-- NFD ALU trims 8491-8494 (each): 2.4 m.
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 8491 AND range = 'ALU. C TRIM' AND supplier = 'NFD' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 8492 AND range = 'ALU. L TRIM' AND supplier = 'NFD' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 8493 AND range = 'ALU. RAMP TRIM' AND supplier = 'NFD' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 8494 AND range = 'ALU. T TRIM' AND supplier = 'NFD' AND piece_length_m IS NULL;
-- Acouslime base plates 10971 and 10972: 3.4 m (inserts for the universal trims).
UPDATE products SET piece_length_m = 3.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 10971 AND range = 'Universal Base Plate' AND sku = 'UBP' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 3.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 10972 AND range = 'Universal Base Plate Plus 20mm' AND sku = 'UBPP' AND piece_length_m IS NULL;
-- Riverhill Universal Aluminium 5891-5894 ("3400 length"; his UTC A and PW, RCT A, UBP): 3.4 m.
UPDATE products SET piece_length_m = 3.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5891 AND range = 'Universal Aluminium' AND sku = 'UTC (A)' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 3.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5892 AND range = 'Universal Aluminium' AND sku = 'UTC PW' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 3.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5893 AND range = 'Universal Aluminium' AND sku = 'RCT(A)' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 3.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5894 AND range = 'Universal Aluminium' AND sku = 'UBP' AND piece_length_m IS NULL;
-- Riverhill Elegant Hybrid 5877-5880 and 5882-5885: 2.4 m ("all the rest"; none is one of his 3.4 m items).
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5877 AND range = 'Elegant Hybrid 6.5mm' AND sku = 'Scotia' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5878 AND range = 'Elegant Hybrid 6.5mm' AND sku = 'Reducer' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5879 AND range = 'Elegant Hybrid 6.5mm' AND sku = 'L-molding' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5880 AND range = 'Elegant Hybrid 6.5mm' AND sku = 'T-molding' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5882 AND range = 'Elegant Hybrid 6.5mm' AND sku = 'Base Channel' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5883 AND range = 'Elegant Hybrid 9.5mm' AND sku = 'Scotia' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5884 AND range = 'Elegant Hybrid 9.5mm' AND sku = 'L-molding' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5885 AND range = 'Elegant Hybrid 9.5mm' AND sku = 'T-molding' AND piece_length_m IS NULL;
-- Sunstar 6133-6139: T-Trim and L-Trim 2.4 m, Universal Trim 2.7 m (his answer); C-Trim 2.7 m (every size on both C-Trim records is 2700); scotia 2.4 m (2400 on the record).
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 6133 AND range = 'Vinyl Wrapped' AND sku = 'T-Trim' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.7, updated_at = cast(strftime('%s','now') as integer) WHERE id = 6134 AND range = 'Vinyl Wrapped' AND sku = 'Universal Trim' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 6135 AND range = 'Vinyl Wrapped' AND sku = 'L-Trim' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.7, updated_at = cast(strftime('%s','now') as integer) WHERE id = 6136 AND range = 'Vinyl Wrapped' AND sku = 'C-Trim' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.7, updated_at = cast(strftime('%s','now') as integer) WHERE id = 6137 AND range = 'Black / Silver / Champagne' AND sku = 'C-Trim' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 6138 AND range = 'Colour Matched' AND sku = 'MDF Scotia' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 6139 AND range = 'Colour Matched' AND sku = 'WPC Scotia' AND piece_length_m IS NULL;
-- Mitre 10 Pine Mouldings 7201-7230 (each, sold as a whole 5.4 m length): 5.4 m.
UPDATE products SET piece_length_m = 5.4, updated_at = cast(strftime('%s','now') as integer) WHERE id BETWEEN 7201 AND 7230 AND brand = 'Mitre 10' AND range LIKE 'Pine Moulding%' AND unit = 'each' AND length_mm = 5400 AND piece_length_m IS NULL;

-- 2. Item type, from the record's own SKU.
UPDATE products SET category = 'scotia', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5877 AND range = 'Elegant Hybrid 6.5mm' AND sku = 'Scotia' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5878 AND range = 'Elegant Hybrid 6.5mm' AND sku = 'Reducer' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5879 AND range = 'Elegant Hybrid 6.5mm' AND sku = 'L-molding' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5880 AND range = 'Elegant Hybrid 6.5mm' AND sku = 'T-molding' AND category = 'accessory';
UPDATE products SET category = 'scotia', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5883 AND range = 'Elegant Hybrid 9.5mm' AND sku = 'Scotia' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5884 AND range = 'Elegant Hybrid 9.5mm' AND sku = 'L-molding' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5885 AND range = 'Elegant Hybrid 9.5mm' AND sku = 'T-molding' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5891 AND range = 'Universal Aluminium' AND sku = 'UTC (A)' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5892 AND range = 'Universal Aluminium' AND sku = 'UTC PW' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 5893 AND range = 'Universal Aluminium' AND sku = 'RCT(A)' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 6133 AND range = 'Vinyl Wrapped' AND sku = 'T-Trim' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 6134 AND range = 'Vinyl Wrapped' AND sku = 'Universal Trim' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 6135 AND range = 'Vinyl Wrapped' AND sku = 'L-Trim' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 6136 AND range = 'Vinyl Wrapped' AND sku = 'C-Trim' AND category = 'accessory';
UPDATE products SET category = 'trim', updated_at = cast(strftime('%s','now') as integer) WHERE id = 6137 AND range = 'Black / Silver / Champagne' AND sku = 'C-Trim' AND category = 'accessory';
UPDATE products SET category = 'scotia', updated_at = cast(strftime('%s','now') as integer) WHERE id = 6138 AND range = 'Colour Matched' AND sku = 'MDF Scotia' AND category = 'accessory';
UPDATE products SET category = 'scotia', updated_at = cast(strftime('%s','now') as integer) WHERE id = 6139 AND range = 'Colour Matched' AND sku = 'WPC Scotia' AND category = 'accessory';
-- Mitre 10 Pine Mouldings: new skirting board.
UPDATE products SET category = 'skirting', updated_at = cast(strftime('%s','now') as integer) WHERE id BETWEEN 7201 AND 7230 AND brand = 'Mitre 10' AND range LIKE 'Pine Moulding%' AND unit = 'each' AND length_mm = 5400 AND category = 'accessory';

-- 3. Dunlop T-Trim Riverfields 9885-9908: length confirmed.
UPDATE products SET notes = replace(notes, '(PDF says 60 m/length - check)', '(2.4 m length confirmed by Damien, 7 Nov 2026)'), updated_at = cast(strftime('%s','now') as integer) WHERE id BETWEEN 9885 AND 9908 AND range LIKE 'T-Trim Riverfields%' AND piece_length_m = 2.4 AND notes LIKE '%(PDF says 60 m/length - check)%';

-- 4. Vinyl type, by supplier and range (roll goods only).
-- Commercial Sheet
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Airlay' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl') AND range IN ('Ultra Crystal PUR Homogeneous Vinyl', 'Marble Effects PUR Homogeneous Vinyl', 'Wood Impressions PUR Heterogeneous Vinyl');
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Armstrong Flooring' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl') AND range IN ('Accolade Plus', 'Armalon NG - Black', 'Armalon NG - Colours', 'Natralis', 'Quantum', 'Spectra', 'Timberline Plus');
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND brand = 'Forbo' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl') AND range IN ('Eternal Colour', 'Eternal Material', 'Eternal Next', 'Eternal Original', 'Eternal Wood');
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND brand = 'Forbo' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl') AND range IN ('Marmoleum Acoustic', 'Marmoleum Cocoa', 'Marmoleum Concrete', 'Marmoleum Decibel', 'Marmoleum Fresco', 'Marmoleum Linear Striato', 'Marmoleum Ohmex', 'Marmoleum Piano', 'Marmoleum Real', 'Marmoleum Splash', 'Marmoleum Terra', 'Marmoleum Vivace', 'Marmoleum Walton');
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND brand = 'Forbo' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl') AND range IN ('Modul''up 19 dB', 'Modul''up Compact', 'Modul''up TE', 'Planet Oceania', 'Sarlon 15 dB', 'Sarlon 19 dB');
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND brand = 'Forbo' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl') AND range IN ('Sphera EC', 'Sphera Element', 'Sphera Elite b+', 'Sphera Energetic', 'Sphera Essence', 'Sphera SD');
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Tarkett' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl') AND range IN ('Granit Safe.T', 'Primo Premium', 'Ruby 70', 'Safetred Universal PU', 'iQ Eminent', 'iQ Granit (New)');
-- Domestic Sheet
UPDATE products SET tier = 'Domestic Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'MJS Floorcoverings' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl') AND range IN ('Easy Living', 'Inspire', 'Trojan', 'Trojan Plus');
