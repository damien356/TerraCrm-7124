-- Who gets what on a job (Damien, 14 Nov 2026).
--
-- Quotes, variations and invoices ticked per person and for the company on
-- each job. No row, or a null tick, means the default from the person's role
-- (lib/paperwork.ts): owners and tenants off on company jobs, tenants off on
-- private jobs, everyone else as before. The server checks every quote,
-- variation and invoice send against it, To, CC and text.
--
-- Additive: one new empty table. Nothing existing is changed. Fails
-- harmlessly with "table already exists" if it has already run.
CREATE TABLE `job_paperwork` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`contact_id` integer,
	`company_id` integer,
	`gets_quotes` integer,
	`gets_variations` integer,
	`gets_invoices` integer,
	`set_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "job_paperwork_one_of" CHECK((contact_id is null) <> (company_id is null))
);
CREATE UNIQUE INDEX `job_paperwork_person_uq` ON `job_paperwork` (`job_id`,`contact_id`) WHERE contact_id is not null;
CREATE UNIQUE INDEX `job_paperwork_company_uq` ON `job_paperwork` (`job_id`,`company_id`) WHERE company_id is not null;
