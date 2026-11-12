-- Staged jobs and progress payments (Damien, 12 Nov 2026).
--
-- One job, several visits. Lets the office record that a job is being done in
-- stages (agreed up front, or the rest held because the site is not ready),
-- bill the full agreed material amount when the staging is agreed, bill labour
-- as each stage is finished, and let the installer claim only the pay the
-- office approved for the work he finished. lib/staged-jobs.ts.
--
-- 1. job_stage_plans: the arrangement, its reason, who asked, the selling split
--    and the customer's written confirmation. One open plan per job.
-- 2. job_stages: each visit or part of the work, two or more per plan.
-- 3. job_stage_lines: customer labour selling value per stage, off the
--    accepted quote's own labour lines.
-- 4. job_stage_pay: installer pay per stage, approved by the office, claimed once.
-- 5. One new job status, "Part complete, awaiting client/builder" (stage
--    active), so a part finished job never reads as Complete or Paid and gets
--    no care emails or review requests. Existing statuses are not reordered.
--
-- Additive. No quote, invoice, payment, task, pay line, approved time or job
-- cost is changed. New tables only, plus one status row that is added only if
-- it is not already there. Run once. The CREATE TABLE lines fail harmlessly
-- with "table already exists" if it has already run.
CREATE TABLE `job_stage_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`quote_id` integer,
	`kind` text DEFAULT 'planned' NOT NULL,
	`reason` text DEFAULT 'client_requested' NOT NULL,
	`reason_note` text DEFAULT '' NOT NULL,
	`requested_by` text DEFAULT '' NOT NULL,
	`requested_on` text,
	`arrangement` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`materials_inc` real DEFAULT 0 NOT NULL,
	`labour_inc` real DEFAULT 0 NOT NULL,
	`split_source` text DEFAULT 'quote_lines' NOT NULL,
	`split_note` text DEFAULT '' NOT NULL,
	`split_approved_by_name` text,
	`split_approved_at` integer,
	`variation_timing` text DEFAULT 'final' NOT NULL,
	`follow_up_date` text,
	`materials_location` text DEFAULT '' NOT NULL,
	`confirmed_by_name` text,
	`confirmed_on` text,
	`confirmed_how` text,
	`confirmation_text` text,
	`confirmation_recorded_by_name` text,
	`confirmation_recorded_at` integer,
	`invoice_seq` integer DEFAULT 0 NOT NULL,
	`materials_invoice_id` integer,
	`created_by_name` text DEFAULT '' NOT NULL,
	`closed_at` integer,
	`cancelled_at` integer,
	`cancelled_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`materials_invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null
);

--> statement-breakpoint
CREATE INDEX `job_stage_plans_job_idx` ON `job_stage_plans` (`job_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_stage_plans_open_uq` ON `job_stage_plans` (`job_id`) WHERE status in ('draft','agreed');
--> statement-breakpoint
CREATE TABLE `job_stages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`seq` integer DEFAULT 1 NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`planned_date` text,
	`awaiting_readiness` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`completed_on` text,
	`completed_by_name` text,
	`completed_at` integer,
	`invoice_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `job_stage_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null
);

--> statement-breakpoint
CREATE INDEX `job_stages_plan_idx` ON `job_stages` (`plan_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_stages_plan_seq_uq` ON `job_stages` (`plan_id`,`seq`);
--> statement-breakpoint
CREATE TABLE `job_stage_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer NOT NULL,
	`stage_id` integer NOT NULL,
	`quote_item_id` integer NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`unit` text DEFAULT 'm2' NOT NULL,
	`qty` real DEFAULT 0 NOT NULL,
	`amount_inc` real DEFAULT 0 NOT NULL,
	`amount_typed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `job_stage_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stage_id`) REFERENCES `job_stages`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX `job_stage_lines_plan_idx` ON `job_stage_lines` (`plan_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_stage_lines_uq` ON `job_stage_lines` (`stage_id`,`quote_item_id`);
--> statement-breakpoint
CREATE TABLE `job_stage_pay` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer NOT NULL,
	`stage_id` integer NOT NULL,
	`task_id` integer NOT NULL,
	`installer_id` integer,
	`line_key` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`unit` text DEFAULT 'm2' NOT NULL,
	`qty` real DEFAULT 0 NOT NULL,
	`rate` real,
	`amount` real,
	`estimated_hours` real,
	`amount_typed` integer DEFAULT false NOT NULL,
	`approved_by_name` text,
	`approved_at` integer,
	`claim_invoice_id` integer,
	`reassigned_from_installer_id` integer,
	`change_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `job_stage_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stage_id`) REFERENCES `job_stages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `job_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installer_id`) REFERENCES `installers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`claim_invoice_id`) REFERENCES `installer_invoices`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reassigned_from_installer_id`) REFERENCES `installers`(`id`) ON UPDATE no action ON DELETE set null
);

--> statement-breakpoint
CREATE INDEX `job_stage_pay_plan_idx` ON `job_stage_pay` (`plan_id`);
--> statement-breakpoint
CREATE INDEX `job_stage_pay_installer_idx` ON `job_stage_pay` (`installer_id`,`task_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_stage_pay_uq` ON `job_stage_pay` (`stage_id`,`task_id`,`line_key`);
--> statement-breakpoint
INSERT INTO job_statuses (name, colour, sort_order, stage, active, created_at, updated_at)
SELECT 'Part complete, awaiting client/builder', '#B5651D', 5, 'active', 1, unixepoch(), unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM job_statuses WHERE lower(name) = 'part complete, awaiting client/builder');
