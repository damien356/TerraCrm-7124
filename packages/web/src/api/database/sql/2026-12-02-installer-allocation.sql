-- Installer allocation, day rates and hourly rate (Damien's brief, 7 Nov 2026).
-- Needs the four catalog files first (2026-11-28, 2026-11-29, 2026-11-30 and
-- 2026-12-01), which are already live.
--
-- 1. labour_rate_items.restricted: 1 on a rate item that only shows for a
--    contractor once it is switched on for him. Every existing item gets 0,
--    so nothing changes for any item except the three day rates in step 4.
-- 2. installer_rate_item_access: each switch on or off for one contractor
--    and one item, from a date, with who did it. Never edited in place, so
--    the history stays. Empty to start: nobody has a day rate switched on.
-- 3. job_tasks.agreed_hourly_rate and agreed_terms_id: the hourly rate agreed
--    when hourly work was allocated, so approval pays that rate even if his
--    terms change later. Every existing task gets null (no change: approval
--    falls back to the terms of the day, as it does today).
-- 4. The three day rates become restricted: 73 Day rate one man, 74 Day rate
--    two man crew, 103 Day rate leading hand. Only when the item is still a
--    no-skill "other" item, as it is live.
--
-- Additive only. Nothing is deleted. No rates, names, quotes, tasks, offers,
-- invoices or bookings are changed. The per-contractor $0 day rate rows that
-- already exist (installers 17 and 21) are not touched, and are not switched
-- on here: that is Damien's call, made on the contractor's rate card.
-- The ALTERs are run once: the apply script checks the columns first.
ALTER TABLE labour_rate_items ADD COLUMN restricted integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `installer_rate_item_access` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`installer_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`enabled` integer NOT NULL,
	`effective_from` text NOT NULL,
	`note` text,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`installer_id`) REFERENCES `installers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `labour_rate_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rate_item_access_idx` ON `installer_rate_item_access` (`installer_id`,`item_id`,`effective_from`);
--> statement-breakpoint
ALTER TABLE job_tasks ADD COLUMN agreed_hourly_rate real;
--> statement-breakpoint
ALTER TABLE job_tasks ADD COLUMN agreed_terms_id integer;
--> statement-breakpoint
UPDATE labour_rate_items SET restricted = 1, updated_at = cast(strftime('%s','now') as integer) WHERE id IN (73, 74, 103) AND skill_id IS NULL AND group_name = 'other' AND restricted = 0;
