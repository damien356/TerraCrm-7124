-- An agreed whole-job price revision (Damien, 18 Nov 2026, job 188070).
--
-- The builder and Terra agree one figure for the whole job in place of the
-- accepted quote plus the variations it covers. The quote, the variations and
-- every sent document stay as they are. The row keeps the original figure,
-- the new one, the difference, the reason and where the builder stands on it
-- (budget_allowance until Damien confirms it). While a revision is active the
-- job value is the revised figure, the final invoice shows one fixed price
-- line and goes to the job's Bill to, and no invoice on it can be emailed
-- until the price is confirmed.
--
-- invoices.price_revision_id ties an invoice to the revision it bills.
-- invoices.replaces_invoice_id is the voided invoice it was raised to replace.
--
-- Additive: one new empty table and two new nullable columns. Nothing
-- existing is changed. Fails harmlessly with "table already exists" or
-- "duplicate column name" if it has run.
CREATE TABLE `job_price_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`quote_id` integer,
	`from_subtotal` real DEFAULT 0 NOT NULL,
	`from_total` real DEFAULT 0 NOT NULL,
	`to_subtotal` real DEFAULT 0 NOT NULL,
	`to_gst` real DEFAULT 0 NOT NULL,
	`to_total` real DEFAULT 0 NOT NULL,
	`diff_subtotal` real DEFAULT 0 NOT NULL,
	`diff_total` real DEFAULT 0 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`scope_unchanged` integer DEFAULT 1 NOT NULL,
	`builder_position` text DEFAULT 'budget_allowance' NOT NULL,
	`builder_note` text,
	`confirmed_at` integer,
	`confirmed_by_name` text,
	`invoice_wording` text DEFAULT '' NOT NULL,
	`included_variation_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`withdrawn_at` integer,
	`withdrawn_by_name` text,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE INDEX `job_price_revisions_job_idx` ON `job_price_revisions` (`job_id`);
ALTER TABLE `invoices` ADD `price_revision_id` integer;
ALTER TABLE `invoices` ADD `replaces_invoice_id` integer;
