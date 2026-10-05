# People and three access levels

## SQL to run on the live database BEFORE publishing
```sql
ALTER TABLE profiles ADD COLUMN phone text;
ALTER TABLE profiles ADD COLUMN can_see_costs integer NOT NULL DEFAULT 0;
ALTER TABLE installers ADD COLUMN archived_at integer;
ALTER TABLE quotes ADD COLUMN discount_approved_percent real NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN discount_approved_by text;
ALTER TABLE quotes ADD COLUMN discount_approved_at integer;
ALTER TABLE quote_items ADD COLUMN list_unit_price real;
-- Admin Test and QA Board Check become Office (Damien's call). Damien stays admin.
UPDATE profiles SET role = 'office' WHERE name IN ('Admin Test','QA Board Check');
```
Existing `admin` stays Admin. Existing `installer` is read as Field crew, no data change needed.
Also run the pass_on_to_customer SQL from docs/bulk-pricing-change.md.

## What changed
- Logins and Installers are one People page (/team). /installers redirects there.
- Levels: Admin, Office, Field crew. Enforced in the API (middleware/auth.ts: adminOnly, staffOnly, installerOnly).
- Setting Field crew creates or restores the installer card. Moving to Admin/Office archives it, history stays.
- Cannot leave zero active Admins. Only Admins change levels.
- Office: no price book, costs, markups, specials, suppliers editing, labour rates, settings, integrations, logins, deletes, customer credit limit, installer rates and bank details. Sees installer invoices and suppliers.
- Costs and margins are removed from quote responses unless Admin or the per-person switch is on. Only Admin can set a unit cost.
- Quote discount: a hand-edited line price below the price book price counts. Limit is a setting (default 5%). Over it, Office cannot send until an Admin clicks Approve.
- Voice and Siri: crew Siri keys now require a Field crew login. Office can use voice drafts and memos. No voice path writes prices.
- New sign-ups start as Field crew and get an installer card automatically.
