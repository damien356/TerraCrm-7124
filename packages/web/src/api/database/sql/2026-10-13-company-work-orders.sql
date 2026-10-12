-- Insurance builders import (work order spec part 1). Four text columns on companies, nothing dropped.
-- The accounts email stays in companies.email, which invoices already use.
ALTER TABLE companies ADD COLUMN compliance_email text;
ALTER TABLE companies ADD COLUMN admin_email text;
ALTER TABLE companies ADD COLUMN work_order_prefix text;
ALTER TABLE companies ADD COLUMN work_order_sender text;
