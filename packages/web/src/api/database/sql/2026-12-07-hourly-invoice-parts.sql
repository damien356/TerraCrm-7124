-- Hourly invoices in parts (Damien, 11 Nov 2026).
--
-- Hourly time approved after a contractor has already invoiced a task must be
-- invoiceable on its own, without billing the earlier hours again.
--
-- 1. installer_invoices.part: 1 on every existing invoice. A later invoice on
--    the same task and person for hours approved after the first gets 2, 3 ...
-- 2. The one-invoice-per-task index becomes one invoice per task, person and
--    part. Part 1 is still unique, so a double tap can never make two first
--    invoices, and each part is unique the same way.
--
-- Additive. No invoice, amount, status, line, approved time or job cost is
-- changed. Every existing row keeps exactly what it has and reads as part 1.
-- Run once, before the website is published. The ALTER fails harmlessly with
-- "duplicate column name: part" if it has already run; the index lines are safe
-- to run again.
ALTER TABLE installer_invoices ADD COLUMN part integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `installer_invoice_task_part_unique` ON `installer_invoices` (`task_id`,`installer_id`,`part`);
--> statement-breakpoint
DROP INDEX IF EXISTS `installer_invoice_task_unique`;
