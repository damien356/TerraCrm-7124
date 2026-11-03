-- Warehouse stock, Stage 1 (Step A). ADDITIONS ONLY.
-- New tables, and new optional columns on existing tables. Nothing is
-- renamed or removed. The four Terra Stock tables already on live
-- (stock_movements, stock_reservations, stocktakes, stocktake_lines) keep
-- every column; today's Crew materials list reads job_material_id and status
-- from stock_reservations and still can.
-- Run scripts/stock/migrate-dry-run.ts first: it stops if any of the four
-- stock tables has a row.
-- Not in this file (already on live, code alignment only): products
-- stock_tracked, installer_can_buy, reorder_level, reorder_qty,
-- stock_unit_label, low_stock_alerted_at; purchase_orders.kind;
-- purchase_order_lines.received_qty.
CREATE TABLE `stock_locations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`product_id` integer NOT NULL,
	`type` text NOT NULL,
	`parent_item_id` integer,
	`supplier_id` integer,
	`supplier_roll_no` text DEFAULT '' NOT NULL,
	`colour` text DEFAULT '' NOT NULL,
	`batch` text,
	`location_id` integer,
	`condition` text DEFAULT 'good' NOT NULL,
	`status` text DEFAULT 'to_check' NOT NULL,
	`unit` text NOT NULL,
	`qty` real DEFAULT 0 NOT NULL,
	`original_qty` real DEFAULT 0 NOT NULL,
	`width_m` real,
	`length_source` text,
	`width_source` text,
	`pack_size` real,
	`cost_per` text DEFAULT 'unit' NOT NULL,
	`unit_cost` real,
	`goods_cost` real,
	`freight_cost` real,
	`cost_status` text DEFAULT 'unknown' NOT NULL,
	`purchase_cost_note` text DEFAULT '' NOT NULL,
	`po_id` integer,
	`po_line_id` integer,
	`bought_for_job_id` integer,
	`origin_job_id` integer,
	`cost_on_job_id` integer,
	`cost_carry` real DEFAULT 0 NOT NULL,
	`terra_owned` integer DEFAULT true NOT NULL,
	`made_on` text,
	`expires_on` text,
	`received_on` text,
	`note` text DEFAULT '' NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`approved_by_name` text,
	`approved_at` integer,
	`request_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_item_id`) REFERENCES `stock_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`location_id`) REFERENCES `stock_locations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`po_line_id`) REFERENCES `purchase_order_lines`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`bought_for_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`origin_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cost_on_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `stock_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`sale_id` integer,
	`kind` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`deposit_percent` real,
	`proposed_percent` real,
	`order_total` real,
	`required_deposit` real,
	`frozen_at` integer,
	`invoice_id` integer,
	`joined_via` text DEFAULT 'switch' NOT NULL,
	`brought_in_by_name` text,
	`brought_in_at` integer,
	`start_position` text,
	`review_note` text DEFAULT '' NOT NULL,
	`last_check_at` integer,
	`last_check_error` text,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sale_id`) REFERENCES `product_sales`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `stock_counts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_item_id` integer NOT NULL,
	`expected_qty` real NOT NULL,
	`counted_qty` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`by_name` text DEFAULT '' NOT NULL,
	`approved_by_name` text,
	`movement_id` integer,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`stock_item_id`) REFERENCES `stock_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stock_payment_confirmations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payment_id` integer NOT NULL,
	`invoice_id` integer NOT NULL,
	`amount` real NOT NULL,
	`by_profile_id` integer,
	`by_name` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `invoice_payments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`by_profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `stock_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`order_id` integer,
	`job_id` integer,
	`title` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`alert_id` integer,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `stock_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stock_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`handle` integer DEFAULT false NOT NULL,
	`allocate` integer DEFAULT false NOT NULL,
	`change_costs` integer DEFAULT false NOT NULL,
	`granted_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE stock_movements ADD COLUMN stock_item_id integer REFERENCES stock_items(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE stock_movements ADD COLUMN unit text;
--> statement-breakpoint
ALTER TABLE stock_movements ADD COLUMN request_key text;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN stock_item_id integer REFERENCES stock_items(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN order_id integer REFERENCES stock_orders(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN sale_line_id integer REFERENCES product_sale_lines(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN line_unit text;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN ordered_qty real;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN billed_qty real;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN free_qty real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN free_state text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN free_by_name text;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN cost_on_po integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN expires_at integer;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN warned_at integer;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN extend_reason text;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN applied_by_profile_id integer REFERENCES profiles(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN applied_by_name text;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN released_at integer;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN release_reason text;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN replaced_by_id integer;
--> statement-breakpoint
ALTER TABLE stock_reservations ADD COLUMN request_key text;
--> statement-breakpoint
ALTER TABLE job_costs ADD COLUMN stock_ref text;
--> statement-breakpoint
ALTER TABLE invoice_payments ADD COLUMN source text;
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_alerts_key_uq` ON `stock_alerts` (`key`);
--> statement-breakpoint
CREATE INDEX `stock_counts_item_idx` ON `stock_counts` (`stock_item_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_items_code_uq` ON `stock_items` (`code`);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_items_request_uq` ON `stock_items` (`request_key`);
--> statement-breakpoint
CREATE INDEX `stock_items_product_idx` ON `stock_items` (`product_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_locations_name_uq` ON `stock_locations` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_orders_job_uq` ON `stock_orders` (`job_id`);
--> statement-breakpoint
CREATE INDEX `stock_orders_status_idx` ON `stock_orders` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_payment_confirmations_payment_uq` ON `stock_payment_confirmations` (`payment_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_permissions_profile_uq` ON `stock_permissions` (`profile_id`);
--> statement-breakpoint
CREATE INDEX `stock_movements_item_idx` ON `stock_movements` (`stock_item_id`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_movements_request_uq` ON `stock_movements` (`request_key`);
--> statement-breakpoint
CREATE INDEX `stock_reservations_item_idx` ON `stock_reservations` (`stock_item_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_reservations_request_uq` ON `stock_reservations` (`request_key`);
--> statement-breakpoint
INSERT INTO stock_locations (name, active, sort_order, created_at, updated_at) VALUES ('Unsorted', 1, 0, unixepoch(), unixepoch());
