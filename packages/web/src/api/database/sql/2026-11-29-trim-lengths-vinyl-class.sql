-- Trim lengths and vinyl classification (Damien's brief, 7 Nov 2026, second
-- brief). Catalog data only. Needs 2026-11-28-quote-defaults.sql first.
--
-- 1. piece_length_m on 26 trim and scotia records whose own record states the
--    length (size "3400x18x6.5", "2400 x 28mm", "2700mm", notes "Sold per
--    2.4m length"). Each record keeps its own length. Prices are not touched:
--    every one of these is priced per length (each) and stays that way.
-- 2. Sold as Broadloom on the 714 Forbo vinyl rows (Flooring Distributors of
--    Australia). All are roll goods, 2 m wide, priced per m2, as Polyflor.
-- 3. Tier (flooring type) where the supplier's own range name or notes say it:
--    Safety Sheet, Commercial Sheet or Wall Vinyl. Ranges that do not say are
--    left blank and stay flagged on a quote. The selling unit is not changed.
--
-- Not touched: prices, units, names, quotes, quote lines, orders, jobs.
-- Each step only runs on a row still in its expected state, so running the
-- file twice changes nothing the second time.

-- 1. Lengths, by id and name, only where none is recorded yet.
UPDATE products SET piece_length_m = 3.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5895 AND range = 'Junior End Trim' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 3.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5896 AND range = 'Junior End Trim' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 3.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 5897 AND range = 'Junior End Trim' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 7159 AND range = 'Oakwood Quads/Scotia' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 7160 AND range = 'Oakwood Quads/Scotia' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 7161 AND range = 'Oakwood Quads/Scotia' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 7162 AND range = 'Oakwood Quads/Scotia' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 7163 AND range = 'Oakwood Quads/Scotia' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 7164 AND range = 'Oakwood Quads/Scotia' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 7165 AND range = 'Rustic Quads/Scotia' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 7166 AND range = 'Rustic Quads/Scotia' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 7167 AND range = 'Rustic Quads/Scotia' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 7168 AND range = 'Rustic Quads/Scotia' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 7169 AND range = 'Rustic Quads/Scotia' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 8501 AND range = 'SCOTIA' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 8502 AND range = 'SCOTIA TIMBER' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 8503 AND range = 'T TRIM TIMBER' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 8545 AND range = 'Scotia PVC/WPC' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.7, updated_at = cast(strftime('%s','now') as integer) WHERE id = 8548 AND range = 'Universal Trim' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 8549 AND range = 'Reducer' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 10060 AND range = 'Matching L angle profile' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 10061 AND range = 'Matching T, Ramp & End profile' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 2.4, updated_at = cast(strftime('%s','now') as integer) WHERE id = 10062 AND range = 'Matching scotia trims' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 3.0, updated_at = cast(strftime('%s','now') as integer) WHERE id = 10063 AND range = 'Metal 10mm C Channel' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 3.0, updated_at = cast(strftime('%s','now') as integer) WHERE id = 10064 AND range = 'Metal 2cm x 1cm L Trim' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;
UPDATE products SET piece_length_m = 3.0, updated_at = cast(strftime('%s','now') as integer) WHERE id = 10065 AND range = 'Metal 8mm C Channel' AND category = 'accessory' AND unit = 'each' AND piece_length_m IS NULL;

-- 2. Forbo sheet: Sold as Broadloom.
UPDATE products SET sold_as = 'broadloom', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND brand = 'Forbo' AND category = 'vinyl' AND unit = 'm2' AND bulk_kind = 'roll' AND sold_as IS NULL;

-- 3. Flooring type (tier), by supplier and range, only on sheet still blank or plain "Sheet Vinyl".
-- Safety Sheet
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Surestep Original' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Surestep Star' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Surestep Wood' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Surestep Material' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Surestep Balance' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Surestep Laguna' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Surestep Fast Fit' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Safestep R11' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Safestep R12' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Safestep Aqua' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Armstrong Flooring' AND range = 'Accolade Foothold' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Armstrong Flooring' AND range = 'Accolade Safe' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Armstrong Flooring' AND range = 'Natralis Foothold' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Armstrong Flooring' AND range = 'Safeguard R10' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Armstrong Flooring' AND range = 'Safeguard R11' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Armstrong Flooring' AND range = 'Safeguard R12' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Airlay' AND range = 'SuperSafe R10' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Airlay' AND range = 'SuperSafe R11' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Airlay' AND range = 'SuperSafe R12' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Airlay' AND range = 'AquaSafe Barefoot Safety Sheet Vinyl' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Tarkett' AND range = 'Safetred Universal Plus R12' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Safety Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'MJS Floorcoverings' AND range = 'Somplan Safe.T' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
-- Commercial Sheet
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'MJS Floorcoverings' AND range = 'Somplan 100' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'MJS Floorcoverings' AND range = 'Somplan 350' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'MJS Floorcoverings' AND range = 'Somplan 500' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'MJS Floorcoverings' AND range = 'Somplan 650' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Commercial Sheet', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'MJS Floorcoverings' AND range = 'Xtreme Woods' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
-- Wall Vinyl
UPDATE products SET tier = 'Wall Vinyl', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Armstrong Flooring' AND range = 'Wallflex' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Wall Vinyl', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Tarkett' AND range = 'Wallgard 2mm' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Wall Vinyl', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Onyx Impact wall covering' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Wall Vinyl', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'Flooring Distributors of Australia' AND range = 'Onyx+ wall covering' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Wall Vinyl', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'MJS Floorcoverings' AND range = 'Somwall 1.3 mm' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
UPDATE products SET tier = 'Wall Vinyl', updated_at = cast(strftime('%s','now') as integer) WHERE supplier = 'MJS Floorcoverings' AND range = 'Somwall 2.0 mm' AND category = 'vinyl' AND sold_as = 'broadloom' AND coalesce(tier, '') IN ('', 'Sheet Vinyl');
