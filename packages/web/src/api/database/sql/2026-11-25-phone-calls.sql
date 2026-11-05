-- AI phone calls (Retell, 5 Nov). ADDITIONS ONLY. Run after 2026-11-24-stock-a2.sql.
-- Six new tables. No existing table changes shape, nothing is renamed or removed.
-- Adds the "AI phone call" lead source if it is not there yet.
-- Routing settings are not created here: they live in settings key phone_ai_config,
-- written from Admin, AI phone calls and routing. Until then the agent is off.
CREATE TABLE IF NOT EXISTS `job_managers` (
	`job_id` integer PRIMARY KEY NOT NULL,
	`profile_id` integer NOT NULL,
	`set_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `phone_call_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`call_id` integer NOT NULL,
	`name` text NOT NULL,
	`idem_key` text NOT NULL,
	`args` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`result` text DEFAULT '{}' NOT NULL,
	`error` text,
	`entity_type` text,
	`entity_id` integer,
	`job_id` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `phone_calls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `phone_call_actions_idem_uq` ON `phone_call_actions` (`idem_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_call_actions_call_idx` ON `phone_call_actions` (`call_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `phone_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`retell_call_id` text NOT NULL,
	`agent_id` text,
	`direction` text DEFAULT 'inbound' NOT NULL,
	`from_number` text,
	`to_number` text,
	`withheld` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'live' NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`duration_sec` integer,
	`disconnection_reason` text,
	`matched_contact_ids` text DEFAULT '[]' NOT NULL,
	`verified_contact_id` integer,
	`verify_method` text,
	`verify_attempts` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`contact_id` integer,
	`job_id` integer,
	`new_enquiry` integer DEFAULT false NOT NULL,
	`call_type` text DEFAULT 'other' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`outcome` text DEFAULT '' NOT NULL,
	`needs_person` text DEFAULT '' NOT NULL,
	`sentiment` text,
	`transcript` text,
	`recording_url` text,
	`analysis_state` text DEFAULT 'pending' NOT NULL,
	`owner_profile_id` integer,
	`finalised_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`verified_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `phone_calls_retell_uq` ON `phone_calls` (`retell_call_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_calls_job_idx` ON `phone_calls` (`job_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_calls_contact_idx` ON `phone_calls` (`contact_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_calls_status_idx` ON `phone_calls` (`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `phone_followups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`call_id` integer,
	`job_id` integer,
	`contact_id` integer,
	`call_type` text DEFAULT 'other' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`owner_profile_id` integer,
	`owner_name` text DEFAULT '' NOT NULL,
	`queue_key` text DEFAULT '' NOT NULL,
	`routed_via` text DEFAULT '' NOT NULL,
	`due_at` integer,
	`reminded_at` integer,
	`escalated_at` integer,
	`escalation_level` integer DEFAULT 0 NOT NULL,
	`dedupe_key` text NOT NULL,
	`resolved_at` integer,
	`resolved_by_name` text,
	`resolution` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `phone_calls`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `phone_followups_dedupe_uq` ON `phone_followups` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_followups_open_idx` ON `phone_followups` (`status`,`due_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_followups_owner_idx` ON `phone_followups` (`owner_profile_id`,`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_followups_job_idx` ON `phone_followups` (`job_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `phone_notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`call_id` integer,
	`followup_id` integer,
	`profile_id` integer,
	`reason` text NOT NULL,
	`channel` text NOT NULL,
	`status` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`alert_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `phone_calls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`followup_id`) REFERENCES `phone_followups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE set null
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_notifications_followup_idx` ON `phone_notifications` (`followup_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `phone_notifications_call_idx` ON `phone_notifications` (`call_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `staff_cover` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`cover_profile_id` integer NOT NULL,
	`kind` text DEFAULT 'leave' NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text,
	`reason` text DEFAULT '' NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`cancelled_at` integer,
	`cancelled_by_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cover_profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `staff_cover_profile_idx` ON `staff_cover` (`profile_id`,`from_date`);
--> statement-breakpoint
INSERT INTO `lead_sources` (`name`, `active`, `sort_order`, `created_at`, `updated_at`)
SELECT 'AI phone call', 1, (SELECT coalesce(max(`sort_order`), 0) + 1 FROM `lead_sources`), unixepoch(), unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM `lead_sources` WHERE `name` = 'AI phone call');
