-- Trade sales (materials sold to installers and other trade buyers).
-- Additive only: new tables and indexes. No existing table is altered.
-- The stock tables (stock_movements and friends) are already on live from
-- 2026-10-06-stock.sql and are reused as they are.
-- Applied by script after a full backup, never through db:push.

-- One settings row. Admin only, so it is not in the shared settings table.
CREATE TABLE `trade_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`markup_pct` real DEFAULT 15 NOT NULL,
	`next_number` integer DEFAULT 188000 NOT NULL,
	`categories` text DEFAULT '[]' NOT NULL,
	`supplier_ids` text DEFAULT '[]' NOT NULL,
	`updated_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
INSERT INTO trade_settings (id, enabled, markup_pct, next_number, categories, supplier_ids, updated_by_name, created_at, updated_at)
  VALUES (1, 0, 15, 188000, '[]', '[]', 'System', unixepoch(), unixepoch());

-- A failed CHECK here rolls a whole write batch back. Always empty.
CREATE TABLE `trade_guard` (
	`ok` integer NOT NULL CHECK (`ok` = 1)
);

CREATE TABLE `trade_product_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`mode` text DEFAULT 'auto' NOT NULL,
	`price_override` real,
	`gst_confirmed` integer DEFAULT false NOT NULL,
	`sell_unit` text,
	`unit_label` text DEFAULT '' NOT NULL,
	`fees_included` integer DEFAULT false NOT NULL,
	`updated_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `trade_product_rules_product_unique` ON `trade_product_rules` (`product_id`);

CREATE TABLE `trade_buyers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`installer_id` integer,
	`contact_id` integer,
	`company_id` integer,
	`active` integer DEFAULT true NOT NULL,
	`categories` text DEFAULT '[]' NOT NULL,
	`credit_approved` integer DEFAULT false NOT NULL,
	`credit_approved_by_name` text,
	`credit_approved_at` integer,
	`terms_days` integer DEFAULT 7 NOT NULL,
	`fee_presentation` text DEFAULT 'itemised' NOT NULL,
	`entity_abn` text,
	`entity_verified_at` integer,
	`entity_verified_by_name` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK ((`installer_id` IS NOT NULL) + (`contact_id` IS NOT NULL) + (`company_id` IS NOT NULL) = 1),
	FOREIGN KEY (`installer_id`) REFERENCES `installers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `trade_buyers_installer_unique` ON `trade_buyers` (`installer_id`);
CREATE UNIQUE INDEX `trade_buyers_contact_unique` ON `trade_buyers` (`contact_id`);
CREATE UNIQUE INDEX `trade_buyers_company_unique` ON `trade_buyers` (`company_id`);

CREATE TABLE `trade_sales` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` integer NOT NULL,
	`buyer_id` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`settle_by` text DEFAULT 'pay' NOT NULL,
	`bill_name` text DEFAULT '' NOT NULL,
	`bill_abn` text,
	`bill_email` text,
	`bill_address` text,
	`terms_days` integer,
	`pay_before_collection` integer DEFAULT true NOT NULL,
	`fee_presentation` text DEFAULT 'itemised' NOT NULL,
	`markup_pct` real,
	`subtotal` real DEFAULT 0 NOT NULL,
	`gst` real DEFAULT 0 NOT NULL,
	`total` real DEFAULT 0 NOT NULL,
	`due_date` text,
	`finalised_at` integer,
	`finalised_by_name` text,
	`sent_at` integer,
	`sent_to` text,
	`cancelled_at` integer,
	`cancelled_by_name` text,
	`cancel_reason` text,
	`arrangement_note` text,
	`arrangement_by_name` text,
	`arrangement_at` integer,
	`rev` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`buyer_id`) REFERENCES `trade_buyers`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `trade_sales_number_unique` ON `trade_sales` (`number`);
CREATE INDEX `trade_sales_buyer_idx` ON `trade_sales` (`buyer_id`, `status`);

CREATE TABLE `trade_sale_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`kind` text DEFAULT 'product' NOT NULL,
	`parent_line_id` integer,
	`product_id` integer,
	`fee_rule_id` integer,
	`fee_kind` text,
	`description` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`sell_unit` text DEFAULT 'each' NOT NULL,
	`unit_label` text DEFAULT '' NOT NULL,
	`qty` real DEFAULT 0 NOT NULL,
	`price_source` text DEFAULT 'calculated' NOT NULL,
	`typed_reason` text,
	`standard_cost_ex_gst` real,
	`cost_unit` text,
	`cost_per_sell_unit` real,
	`stock_per_sell_unit` real,
	`stock_unit` text,
	`m2_per_box` real,
	`roll_width_m` real,
	`markup_pct` real,
	`fee_cost_ex_gst` real,
	`unit_price_ex_gst` real DEFAULT 0 NOT NULL,
	`discount_pct` real DEFAULT 0 NOT NULL,
	`line_ex_gst` real DEFAULT 0 NOT NULL,
	`gst_rate` real DEFAULT 10 NOT NULL,
	`gst_amount` real DEFAULT 0 NOT NULL,
	`line_inc_gst` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `trade_sales`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE INDEX `trade_sale_lines_sale_idx` ON `trade_sale_lines` (`sale_id`, `sort`);
CREATE INDEX `trade_sale_lines_product_idx` ON `trade_sale_lines` (`product_id`);

CREATE TABLE `trade_credit_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`subtotal` real DEFAULT 0 NOT NULL,
	`gst` real DEFAULT 0 NOT NULL,
	`total` real DEFAULT 0 NOT NULL,
	`sent_at` integer,
	`sent_to` text,
	`idem_key` text NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (`seq` >= 2),
	FOREIGN KEY (`sale_id`) REFERENCES `trade_sales`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `trade_credit_notes_seq_unique` ON `trade_credit_notes` (`sale_id`, `seq`);
CREATE UNIQUE INDEX `trade_credit_notes_idem_unique` ON `trade_credit_notes` (`idem_key`);

CREATE TABLE `trade_credit_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`credit_id` integer NOT NULL,
	`sale_line_id` integer NOT NULL,
	`qty` real DEFAULT 0 NOT NULL,
	`line_ex_gst` real DEFAULT 0 NOT NULL,
	`gst_amount` real DEFAULT 0 NOT NULL,
	`line_inc_gst` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`credit_id`) REFERENCES `trade_credit_notes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sale_line_id`) REFERENCES `trade_sale_lines`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE INDEX `trade_credit_lines_line_idx` ON `trade_credit_lines` (`sale_line_id`);

-- Money in (card, bank, cash, other), refunds out, and reversals of a mistaken entry.
CREATE TABLE `trade_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`kind` text DEFAULT 'payment' NOT NULL,
	`method` text DEFAULT 'bank' NOT NULL,
	`amount` real NOT NULL,
	`paid_date` text NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`stripe_ref` text,
	`credit_id` integer,
	`reverses_id` integer,
	`idem_key` text NOT NULL,
	`by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (`amount` > 0),
	FOREIGN KEY (`sale_id`) REFERENCES `trade_sales`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `trade_payments_stripe_unique` ON `trade_payments` (`stripe_ref`);
CREATE UNIQUE INDEX `trade_payments_idem_unique` ON `trade_payments` (`idem_key`);
CREATE UNIQUE INDEX `trade_payments_reverses_unique` ON `trade_payments` (`reverses_id`);
CREATE INDEX `trade_payments_sale_idx` ON `trade_payments` (`sale_id`);

-- Goods physically collected or dispatched. One per sale, ever.
CREATE TABLE `trade_fulfilments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`method` text NOT NULL,
	`stock_override_reason` text,
	`by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `trade_sales`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `trade_fulfilments_sale_unique` ON `trade_fulfilments` (`sale_id`);

-- Goods back on the shelf, fit to sell. Each return is its own record.
CREATE TABLE `trade_returns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`sale_line_id` integer NOT NULL,
	`qty` real NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`idem_key` text NOT NULL,
	`by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (`qty` > 0),
	FOREIGN KEY (`sale_id`) REFERENCES `trade_sales`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sale_line_id`) REFERENCES `trade_sale_lines`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `trade_returns_idem_unique` ON `trade_returns` (`idem_key`);
CREATE INDEX `trade_returns_line_idx` ON `trade_returns` (`sale_line_id`);

-- Which stock movement belongs to which sale line. A line goes out once.
CREATE TABLE `trade_stock_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`movement_id` integer NOT NULL,
	`sale_id` integer NOT NULL,
	`sale_line_id` integer NOT NULL,
	`fulfilment_id` integer,
	`return_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`movement_id`) REFERENCES `stock_movements`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `trade_stock_links_movement_unique` ON `trade_stock_links` (`movement_id`);
CREATE UNIQUE INDEX `trade_stock_links_out_unique` ON `trade_stock_links` (`sale_line_id`, `fulfilment_id`);
CREATE UNIQUE INDEX `trade_stock_links_return_unique` ON `trade_stock_links` (`return_id`);

-- Signed agreements on an installer card. Admin only.
CREATE TABLE `installer_agreements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`installer_id` integer NOT NULL,
	`kind` text DEFAULT 'standing_offset' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`file_key` text NOT NULL,
	`filename` text NOT NULL,
	`signed_date` text NOT NULL,
	`valid_until` text,
	`note` text DEFAULT '' NOT NULL,
	`archived_at` integer,
	`by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`installer_id`) REFERENCES `installers`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE INDEX `installer_agreements_installer_idx` ON `installer_agreements` (`installer_id`);

CREATE TABLE `trade_offsets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`installer_id` integer NOT NULL,
	`bill_id` integer,
	`status` text DEFAULT 'proposed' NOT NULL,
	`amount` real NOT NULL,
	`agreement_ref` text DEFAULT '' NOT NULL,
	`agreement_id` integer,
	`agreement_file_key` text,
	`agreement_filename` text,
	`proposed_by_name` text DEFAULT '' NOT NULL,
	`approved_by_name` text,
	`approved_at` integer,
	`confirmed_by_name` text,
	`confirmed_at` integer,
	`confirmed_amount` real,
	`xero_ref` text,
	`cancelled_by_name` text,
	`cancelled_at` integer,
	`cancel_reason` text,
	`conflict` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (`amount` > 0),
	FOREIGN KEY (`sale_id`) REFERENCES `trade_sales`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`installer_id`) REFERENCES `installers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`bill_id`) REFERENCES `installer_invoices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agreement_id`) REFERENCES `installer_agreements`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE INDEX `trade_offsets_sale_idx` ON `trade_offsets` (`sale_id`, `status`);
CREATE INDEX `trade_offsets_bill_idx` ON `trade_offsets` (`bill_id`, `status`);
-- One open (proposed or approved) offset per sale at a time, so a double click cannot make two.
CREATE UNIQUE INDEX `trade_offsets_open_unique` ON `trade_offsets` (`sale_id`) WHERE `status` IN ('proposed', 'approved');

-- Every money event on an installer bill: cash paid, offsets, and their reversals.
-- The bill's own total is never changed.
CREATE TABLE `installer_bill_settlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bill_id` integer NOT NULL,
	`kind` text NOT NULL,
	`amount` real NOT NULL,
	`offset_id` integer,
	`sale_id` integer,
	`paid_date` text,
	`reference` text DEFAULT '' NOT NULL,
	`reverses_id` integer,
	`reason` text DEFAULT '' NOT NULL,
	`idem_key` text NOT NULL,
	`by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (`amount` >= 0),
	CHECK (`kind` IN ('cash', 'cash_reversal', 'offset', 'offset_reversal')),
	FOREIGN KEY (`bill_id`) REFERENCES `installer_invoices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`offset_id`) REFERENCES `trade_offsets`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `installer_bill_settlements_idem_unique` ON `installer_bill_settlements` (`idem_key`);
CREATE UNIQUE INDEX `installer_bill_settlements_reverses_unique` ON `installer_bill_settlements` (`reverses_id`);
CREATE INDEX `installer_bill_settlements_bill_idx` ON `installer_bill_settlements` (`bill_id`);
-- An offset is applied to a bill once, ever.
CREATE UNIQUE INDEX `installer_bill_settlements_offset_unique` ON `installer_bill_settlements` (`offset_id`) WHERE `kind` = 'offset';

-- The trade audit trail. Its own table, not activity_log, because the
-- dashboard and the contact card show activity_log to Office. Admin only.
CREATE TABLE `trade_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer,
	`sale_id` integer,
	`bill_id` integer,
	`action` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`actor_name` text DEFAULT '' NOT NULL,
	`actor_role` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
CREATE INDEX `trade_audit_sale_idx` ON `trade_audit` (`sale_id`);
CREATE INDEX `trade_audit_bill_idx` ON `trade_audit` (`bill_id`);
CREATE INDEX `trade_audit_entity_idx` ON `trade_audit` (`entity_type`, `entity_id`);
