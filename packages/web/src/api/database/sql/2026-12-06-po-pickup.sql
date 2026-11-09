-- PO pickup from the supplier, and saved supplier depots (Damien's brief, 9 Nov 2026).
--
-- 1. supplier_depots: a supplier's pickup depots or branches. Empty to start.
--    A row is only ever added when the office presses "Save for next time".
-- 2. purchase_orders.pickup_depot_id, pickup_name, pickup_address: where a
--    pickup PO is collected from. Every existing PO gets null, '' and '', and
--    keeps deliver_to warehouse or site exactly as it is. deliver_to may now
--    also be 'pickup' (text column, no change needed).
--
-- Additive only. Nothing is deleted or changed on any supplier, PO, line,
-- address, fee rule, quote, invoice or payment. The ALTERs run once: the
-- apply script checks the columns first.
CREATE TABLE IF NOT EXISTS `supplier_depots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`supplier_id` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`address` text NOT NULL,
	`address_key` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `supplier_depots_supplier_idx` ON `supplier_depots` (`supplier_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `supplier_depots_key_unique` ON `supplier_depots` (`supplier_id`,`address_key`);
--> statement-breakpoint
ALTER TABLE purchase_orders ADD COLUMN pickup_depot_id integer REFERENCES supplier_depots(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE purchase_orders ADD COLUMN pickup_name text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE purchase_orders ADD COLUMN pickup_address text DEFAULT '' NOT NULL;
