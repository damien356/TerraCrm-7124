-- Warehouse stock A2 (4 Nov): supply settings and warehouse orders. ADDITIONS ONLY.
-- Run after 2026-11-23-stock-stage1.sql. New optional columns and two new
-- tables. Nothing is renamed or removed. Every product keeps today's
-- behaviour ("Order for each job/sale") until it is reviewed by hand.
-- purchase_orders.job_id is already nullable on live; only the code changed.
ALTER TABLE `products` ADD `supply_mode` text DEFAULT 'job' NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `preferred_supplier_id` integer REFERENCES suppliers(id);
--> statement-breakpoint
ALTER TABLE `products` ADD `reorder_method` text DEFAULT 'fixed' NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `target_level` real;
--> statement-breakpoint
ALTER TABLE `products` ADD `purchase_unit` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `stock_per_purchase` real;
--> statement-breakpoint
ALTER TABLE `products` ADD `reorder_min_qty` real;
--> statement-breakpoint
ALTER TABLE `products` ADD `order_multiple` real;
--> statement-breakpoint
ALTER TABLE `products` ADD `low_stock_alerts` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `supply_set_at` integer;
--> statement-breakpoint
ALTER TABLE `products` ADD `supply_set_by` text;
--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `expected_pay_date` text;
--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `supplier_deposit_ex_gst` real;
--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `supplier_deposit_due` text;
--> statement-breakpoint
ALTER TABLE `purchase_order_lines` ADD `closed_at` integer;
--> statement-breakpoint
ALTER TABLE `purchase_order_lines` ADD `closed_note` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `stock_po_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`po_id` integer NOT NULL,
	`po_line_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`order_id` integer,
	`reservation_id` integer,
	`job_material_id` integer,
	`quote_item_id` integer,
	`sale_line_id` integer,
	`qty` real NOT NULL,
	`received_qty` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`request_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `stock_orders`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reservation_id`) REFERENCES `stock_reservations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_material_id`) REFERENCES `job_materials`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`quote_item_id`) REFERENCES `quote_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_po_links_key_uq` ON `stock_po_links` (`request_key`);
--> statement-breakpoint
CREATE INDEX `stock_po_links_line_idx` ON `stock_po_links` (`po_line_id`);
--> statement-breakpoint
CREATE INDEX `stock_po_links_job_idx` ON `stock_po_links` (`job_id`);
--> statement-breakpoint
CREATE TABLE `stock_supply_approvals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_key` text NOT NULL,
	`product_id` integer NOT NULL,
	`short_qty` real NOT NULL,
	`note` text NOT NULL,
	`by_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_supply_approvals_uq` ON `stock_supply_approvals` (`entity_type`,`entity_key`,`product_id`);
