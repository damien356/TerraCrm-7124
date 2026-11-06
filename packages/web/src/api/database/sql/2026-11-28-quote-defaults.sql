-- Quote defaults, linked trim install and carpet disposal (Damien's brief,
-- 6 Nov 2026, and his answers the same day).
--
-- quote_items gets four columns:
--   default_for_item_id  on a line put on by default, the line it is for
--   default_key          which default it is, "floor:109", "trim", "disposal"
--   defaults_applied     on the parent, a JSON list of defaults already put
--                        on, so one removed by hand is never put back
--   disposal_typed       on a disposal line, 1 once its qty or price is
--                        typed over, so it stops following the uplift
-- Every existing line gets null, null, null and 0, so nothing on any quote
-- today changes. Defaults only go on newly added lines, on draft quotes.
--
-- Settings gets the two carpet disposal figures Damien gave: $3.00 a m2
-- cost to Terra (shop skip bin) and 15% on top, so it sells at $3.45 a m2.
-- Only added when missing, so a figure already set is never overwritten.
--
-- Additive only. Nothing is deleted. Rate item 86 (Carpet disposal and tip
-- run, contractor paid) is not touched.
-- The ALTERs are run once: the apply script checks the columns first.
ALTER TABLE quote_items ADD COLUMN default_for_item_id integer;
--> statement-breakpoint
ALTER TABLE quote_items ADD COLUMN default_key text;
--> statement-breakpoint
ALTER TABLE quote_items ADD COLUMN defaults_applied text;
--> statement-breakpoint
ALTER TABLE quote_items ADD COLUMN disposal_typed integer NOT NULL DEFAULT 0;
--> statement-breakpoint
INSERT INTO settings (key, value, updated_at) VALUES ('carpet_disposal_cost_per_m2', '3', CAST(strftime('%s', 'now') AS integer))
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO settings (key, value, updated_at) VALUES ('carpet_disposal_markup_pct', '15', CAST(strftime('%s', 'now') AS integer))
ON CONFLICT (key) DO NOTHING;
