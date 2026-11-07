-- Quote defaults, linked trim install and carpet disposal (Damien's brief,
-- 6 Nov 2026, his answers the same day, and his review of 7 Nov).
--
-- quote_items gets seven columns:
--   default_for_item_id  on a line put on by default, the line it is for
--   default_key          which default it is, "floor:109", "trim", "disposal"
--   defaults_applied     on the parent, a JSON list of defaults already put
--                        on, so one removed by hand is never put back
--   disposal_typed       on a disposal line, 1 once its qty or price is
--                        typed over, so it stops following the uplift
--   default_reviewed_by  a default warning marked reviewed: who,
--   default_reviewed_at  when,
--   default_review_note  and the warning they read
-- Every existing line gets null, null, null, 0, null, null and null, so
-- nothing on any quote today changes. Defaults only go on newly added lines,
-- on draft quotes.
--
-- 7 Nov: no Settings are written. The carpet disposal cost ($3.00 a m2) and
-- markup (15%) are pending Damien's confirmation. Until an Admin types them
-- into Settings, a disposal line goes on at $0, flagged "rate not set", and
-- the quote cannot be sent.
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
ALTER TABLE quote_items ADD COLUMN default_reviewed_by text;
--> statement-breakpoint
ALTER TABLE quote_items ADD COLUMN default_reviewed_at integer;
--> statement-breakpoint
ALTER TABLE quote_items ADD COLUMN default_review_note text;
