-- Hourly contractor invoicing (Damien, 13 Nov 2026).
--
-- Lets an hourly contractor invoice his approved time for a day, a week or
-- chosen dates across any number of jobs, with every time entry billed once
-- and only once, and lets the office record what has been paid.
-- lib/hourly-invoice.ts and routes/hourlyInvoices.ts.
--
-- 1. installer_invoice_details: kind, service dates, payment terms (7 days)
--    and due date, and the phone's request key so a retry returns the same
--    invoice. The CHECK refuses an invoice when fewer entries were claimed
--    than were shown on it.
-- 2. installer_invoice_sessions: which time entries an invoice bills. One
--    entry, one invoice, by the unique index.
-- 3. installer_invoice_payments: money paid against an invoice, recorded by
--    the office. Nothing is written to Xero.
-- 4. The rate card item "Contractor labour — per hour" (per contractor only),
--    its id in the setting hourly_labour_item_id, and each hourly person's own
--    rate on it, copied from the base rate of the pay terms in force now, from
--    the same date. Weekend and night multipliers and GST stay on pay terms.
--
-- Additive. No invoice, payment, task, approved time, pay terms row or job
-- cost is changed. Run once. The CREATE TABLE lines fail harmlessly with
-- "table already exists" if it has already run, and the inserts skip rows
-- that are already there.
CREATE TABLE `installer_invoice_details` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`installer_id` integer NOT NULL,
	`kind` text DEFAULT 'task' NOT NULL,
	`period_from` text,
	`period_to` text,
	`terms_days` integer DEFAULT 7 NOT NULL,
	`due_date` text,
	`request_key` text,
	`sessions_expected` integer DEFAULT 0 NOT NULL,
	`sessions_claimed` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `installer_invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installer_id`) REFERENCES `installers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "installer_invoice_details_claim_check" CHECK("installer_invoice_details"."sessions_claimed" = "installer_invoice_details"."sessions_expected")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installer_invoice_details_invoice_unique` ON `installer_invoice_details` (`invoice_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `installer_invoice_details_request_unique` ON `installer_invoice_details` (`installer_id`,`request_key`);
--> statement-breakpoint
CREATE TABLE `installer_invoice_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`session_id` integer NOT NULL,
	`task_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`work_date` text NOT NULL,
	`minutes` integer DEFAULT 0 NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `installer_invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `work_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `installer_invoice_sessions_invoice_idx` ON `installer_invoice_sessions` (`invoice_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `installer_invoice_sessions_session_unique` ON `installer_invoice_sessions` (`session_id`);
--> statement-breakpoint
CREATE TABLE `installer_invoice_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`installer_id` integer NOT NULL,
	`amount` real NOT NULL,
	`paid_on` text NOT NULL,
	`source` text DEFAULT 'office' NOT NULL,
	`external_id` text,
	`note` text,
	`recorded_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `installer_invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installer_id`) REFERENCES `installers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `installer_invoice_payments_invoice_idx` ON `installer_invoice_payments` (`invoice_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `installer_invoice_payments_external_unique` ON `installer_invoice_payments` (`external_id`);
--> statement-breakpoint
INSERT INTO `labour_rate_items` (`name`, `group_name`, `kind`, `unit`, `notes`, `sort_order`, `active`, `site_prep`, `whole_group`, `restricted`, `created_at`, `updated_at`)
SELECT 'Contractor labour — per hour', 'other', 'work', 'hour', 'Hourly contractors only. Each person''s own agreed rate. Weekend and night multipliers are on his pay terms.', 102, 1, 0, 0, 1, unixepoch(), unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM `labour_rate_items` WHERE `name` = 'Contractor labour — per hour' AND `unit` = 'hour');
--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`, `updated_at`)
SELECT 'hourly_labour_item_id', CAST(`id` AS TEXT), unixepoch() FROM `labour_rate_items` WHERE `name` = 'Contractor labour — per hour' AND `unit` = 'hour'
  AND NOT EXISTS (SELECT 1 FROM `settings` WHERE `key` = 'hourly_labour_item_id')
ORDER BY `id` LIMIT 1;
--> statement-breakpoint
INSERT INTO `labour_rates` (`item_id`, `installer_id`, `amount`, `effective_from`, `note`, `created_by_name`, `created_at`, `updated_at`)
SELECT CAST(s.`value` AS INTEGER), t.`installer_id`, t.`base_rate`, t.`effective_from`, 'From his hourly pay terms', 'Terra office', unixepoch(), unixepoch()
FROM `installer_pay_terms` t JOIN `settings` s ON s.`key` = 'hourly_labour_item_id'
WHERE t.`effective_to` IS NULL AND t.`base_rate` > 0
  AND NOT EXISTS (SELECT 1 FROM `labour_rates` r WHERE r.`item_id` = CAST(s.`value` AS INTEGER) AND r.`installer_id` = t.`installer_id`);
--> statement-breakpoint
INSERT INTO `installer_rate_item_access` (`installer_id`, `item_id`, `enabled`, `effective_from`, `note`, `created_by_name`, `created_at`, `updated_at`)
SELECT t.`installer_id`, CAST(s.`value` AS INTEGER), 1, t.`effective_from`, 'Hourly pay terms', 'Terra office', unixepoch(), unixepoch()
FROM `installer_pay_terms` t JOIN `settings` s ON s.`key` = 'hourly_labour_item_id'
WHERE t.`effective_to` IS NULL AND t.`base_rate` > 0
  AND NOT EXISTS (SELECT 1 FROM `installer_rate_item_access` a WHERE a.`item_id` = CAST(s.`value` AS INTEGER) AND a.`installer_id` = t.`installer_id`);
