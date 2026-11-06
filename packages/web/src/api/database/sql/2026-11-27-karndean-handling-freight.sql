-- Karndean charges, rule data for invoice matching (Karndean invoice CI155812,
-- Damien's approval 6 Nov 2026). Data only, needs 2026-11-26 first.
--
-- 1. Fuel Surcharge (793) and Resiloop recycling levy (794) get the wording
--    Karndean print on their invoices: FUELSURCH and RESILOOP.
-- 2. Rule 795 keeps the same record and is renamed "Handling / Freight".
--    Its old name stays in invoice_names, so POs raised before the rename
--    still find it. Karndean print HANDLING.
-- 3. Rule 795 goes back to $80.00 ex GST. Both Karndean invoices, CI154416
--    (27 Oct 2026) and CI155812 (6 Nov 2026), bill HANDLING at $80.00. The
--    $100.70 approved on 27 Oct (price flag 30) was HANDLING $80.00 plus the
--    fuel surcharge ($16.90) and Resiloop levy ($3.80) on CI154416, read
--    together as freight by the old matching.
--
-- Not touched: flag 30 stays approved, flags 28 and 29 stay ignored,
-- activity_log 3959 stays, no PO, invoice, quote, payment or Xero record
-- changes. The rate is the only thing that moves, and only on rule 795.
--
-- Each step only runs on a row still in its expected state, so running the
-- file twice changes nothing the second time.

-- The record of the change goes in first, while the rule still shows $100.70.
INSERT INTO activity_log (entity_type, entity_id, action, detail, actor_name, actor_role)
SELECT 'supplier_fee_rule', 795, 'charge_changed',
  'Handling / Freight (was "Delivery to Gold Coast warehouse"): $100.70 to $80.00. Off Karndean invoices CI154416 (27 Oct 2026) and CI155812 (6 Nov 2026), both HANDLING $80.00 ex GST. The $100.70 approved on 27 Oct (price flag 30) included the fuel surcharge and Resiloop levy. Approved by Damien Lacey.',
  'Damien Lacey', 'admin'
WHERE EXISTS (
  SELECT 1 FROM supplier_fee_rules
  WHERE id = 795 AND supplier_id = 22 AND name = 'Delivery to Gold Coast warehouse' AND abs(amount - 100.7) < 0.0001
);
--> statement-breakpoint

UPDATE supplier_fee_rules
SET name = 'Handling / Freight',
    invoice_names = 'HANDLING, Delivery to Gold Coast warehouse',
    amount = 80,
    condition = 'UPDATED 6 Nov 2026, approved by Damien Lacey: Handling / Freight (was "Delivery to Gold Coast warehouse"): $100.70 to $80.00. Karndean invoices CI154416 (27 Oct 2026) and CI155812 (6 Nov 2026) both bill HANDLING at $80.00 ex GST. The $100.70 from 27 Oct included the fuel surcharge and Resiloop levy, which are their own charges. This overrides anything below that says otherwise. ' || condition,
    updated_at = unixepoch()
WHERE id = 795 AND supplier_id = 22 AND name = 'Delivery to Gold Coast warehouse' AND abs(amount - 100.7) < 0.0001;
--> statement-breakpoint

UPDATE supplier_fee_rules SET invoice_names = 'FUELSURCH', updated_at = unixepoch()
WHERE id = 793 AND supplier_id = 22 AND invoice_names = '';
--> statement-breakpoint

UPDATE supplier_fee_rules SET invoice_names = 'RESILOOP', updated_at = unixepoch()
WHERE id = 794 AND supplier_id = 22 AND invoice_names = '';
