# Bulk price edit and bulk specials

Branch: `feature/crm-changes-wip`. Built in a second chat while the main chat was frozen.

## What it does
Price book (Products page): search a name (for example "Knight tile"), tick products or Select all, then:
- **Edit price**: changes the standard supplier cost. Sell follows the fixed markup chain (x1.3 x1.05 x1.4). Percent, add or take off dollars, or set an exact cost. Optional rounding (5c, 10c, dollar). Percent can also move the cut-roll and volume rates.
- **On special**: dated special on many products. Percent off, dollars off, or exact cost. Choose **keep the profit** (default, sell unchanged) or **give the client the discount** (new quotes price off the special cost until it ends).

Each button opens a form, then a preview of every row (old to new), then a red confirm button. Nothing is written before that. Apply recomputes on the server, it does not trust the browser.
Quotes already written are never changed. Only new quote lines use the new prices.

## DATABASE MIGRATION (production, run from the live side only)
```sql
ALTER TABLE product_specials ADD COLUMN pass_on_to_customer integer NOT NULL DEFAULT 0;
```
(or `bun run db:push` after pulling the branch). Default 0 keeps every existing special behaving as today.
Deploy order: run the migration first, then publish.

## Files
- `api/database/schema.ts`: `productSpecials.passOnToCustomer`
- `api/lib/pricing.ts`: `priceProduct` honours pass-on, new `passedOnToCustomer` field
- `api/lib/bulk-price.ts` (new): rounding and edit/special maths
- `api/lib/live-sell.ts` (new): `liveSellFor`, sell price for NEW quote lines
- `api/routes/products.ts`: `bulkPriceEditPreview/Apply`, `bulkSpecialPreview/Apply`
- `api/routes/quotes.ts`, `api/agent/price.ts`: new lines use `liveSellFor`
- `web/components/bulk-price.tsx` (new), `web/pages/products.tsx`, `web/queries/products.ts`

## Checked
Web and API typecheck clean. Maths spot-checked (percent, dollars, rounding, keep profit vs pass on).
NOT checked: rendering in a browser, and running against the real database.
