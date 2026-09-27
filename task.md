# Terra Ops — Phase 1 build (Terra Flooring ONLY, never link to other businesses)

App: /home/user/terra-ops · web port 4200, mobile 4300
Design contract: /home/user/terra-ops/design.md + the two approved mockups.

## Core principles (approved, do not re-litigate)
- Contacts = people, exist once forever. Companies optional wrapper. Billing per JOB (`jobs.billToType`).
- TASKS are the dispatch unit, not jobs. One job = many dispatches.
- Skills are ticks on the installer card; tasks only go to ticked installers.
- Dispatch: direct or broadcast. Broadcast = first accept wins, others auto-close "filled".
- Furniture on site forces crew size 2; blocks solo assignment.
- Crew capacity: solo / own_offsider / needs_partner.
- Offers show pay up front, expire after 2h, then escalate to admin.
- Installers always see customer name + phone. NEVER see pricing/quotes/invoices/margins/other installers' work.
- Skills, statuses, rates = editable data in Settings, never hardcoded enums.

## Progress
- [x] app_init scaffold, ports fixed
- [x] design.md
- [x] schema.ts (~22 tables) + auth-schema generated + db:push applied
- [x] auth.ts (Better Auth + managed auth + expo)
- [x] middleware/auth.ts (withUser, authed, adminOnly, installerOnly)
- [x] seed.ts run OK (28 skills, 9 statuses, 6 installers, 5 contacts, 4 jobs, 11 tasks)
- [x] routes/settings.ts (skills, statuses, kv, products)
- [x] routes/contacts.ts
- [x] routes/companies.ts (companies + sites)
- [x] routes/installers.ts (+ skill ticks, eligible, load, expiring)
- [x] routes/jobs.ts (+ job contacts, materials, notes, furniture cascade)
- [x] routes/tasks.ts (board, assign, reschedule, furniture rule, checklists)
- [x] routes/offers.ts (direct + broadcast, 2h TTL, first-accept-wins, derivePay)
- [x] routes/quotes.ts (items, GST, revise, accept, convertToJob → tasks + materials)
- [x] routes/dashboard.ts
- [x] routes/field.ts (installerOnly — MUST filter every query by context.installerId)
- [x] mount Better Auth in api/index.ts + compose router
- [x] web: styles.css (Terra tokens + Poppins), lib/auth.ts, lib/api.ts bearer, main.tsx handleRedirect
- [x] web frontend pages (login, dashboard, schedule board, jobs, job detail, clients, contact detail,
      companies, company detail, installers, quotes, quote builder, settings)
- [x] mobile app (login, Today, Coming up, Offers, Me, task/[id]) — no prices anywhere, own pay only
- [x] PHASE 0 (the "if Runable goes bankrupt" insurance):
      - routes/exports.ts — adminOnly CSV per table + full JSON snapshot
      - Settings -> "Your data" tab (download snapshot / CSV per dataset)
      - scripts/backup.ts + `bun run backup` -> backups/<date>/{snapshot.json,*.csv,restore.sql}, backups/latest.json
      - RUNBOOK.md — accounts in his name, GitHub mirror steps, cron line, 3 restore levels, .env warning
      - .gitignore now excludes backups/ (customer data)
- [x] bun run lint clean (fixed template bootstrap import + 30 a11y/unused-var errors)
- [x] bun run build clean (tsc --noEmit + vite build + desktop)
- [x] packages/mobile typecheck clean (fixed stray trailing lines + zod .default({}) in quotes.ts)
- [ ] dev servers up + deliver

## Phase 0 notes
- Damien still has to create his own GitHub repo and paste the URL — RUNBOOK.md step 3 has the exact commands.
- There is no git repo in the app dir yet; `git init` happens when he wants the mirror.
- .env holds DATABASE_URL + DATABASE_AUTH_TOKEN — told him to put both in a password manager.

## Gotchas hit
- Better Auth CLI fails under `bun --env-file`; use `set -a && . ../../.env && set +a && bunx auth@1.6.19 generate ...`
- memory_edit tool keeps rejecting input (malformed param) — the "separate businesses" fact lives here instead.
- Mobile: `bunx expo install`, never `bun add`. Extend `_layout.tsx` in place (keep ErrorBoundary + OneDollarStatsProvider).

## Spec v2 (owner-supplied, 4 Sep 2026)
Full build spec incl. price book, estimating, trim optimiser, Needs Attention engine,
CRM/Zoho, permission profiles, audit, training/rollout: see spec-v2.txt (and spec-v2.pdf).
Locked additions: AI assists retrieval NEVER arithmetic; price-book version snapshots on job
create; highest-eligible-installer-rate for protected labour pre-assignment; areas belong to a
work package not the job; supplier fees per supplier order not per line; blanks are never zero.

## Spec v2 — owner answers (2026-09-04)

- Installer rates in spec v2 §10.12 are **CURRENT 2026 rates** and stored **ex-GST**. Import as Draft, activate after review.
- Pricing is a **markup chain off installer cost**, not a minimum-margin threshold:
  installer cost -> +30% overhead (editable) -> +5% inefficiency (**FIXED, not editable by anyone**) -> +40% profit (editable).
  Exact compounding order NOT yet confirmed — awaiting owner (additive $70.00 / sequential $76.44 / profit-as-margin $91.00 on a $40/LM carpet rate).
- Low-margin warning is derived: fires when an admin **overrides** a price below the formula result. No separate min-margin % needed.
- Email: **Google Workspace / Gmail**, NOT Zoho. Spec v2 §13 Zoho two-way sync -> rebuild as Gmail two-way sync.
- **Terra Ops Admin Mobile (3rd surface): owner said BUILD IT NOW.** Decision accepted, do not re-litigate. Sequenced after estimating core.
- Expo connection root cause found: `EXPO_PACKAGER_PROXY_URL` was unset, so Metro handed the phone `http://127.0.0.1:4300`.
  Fixed by starting mobile with `EXPO_PACKAGER_PROXY_URL=https://terraop-l8jfdfu-preview-4300.runable.site`.
  **Any future mobile dev-server restart MUST set that env var** or Expo Go breaks again.
- **PRICING MATHS LOCKED (owner, 4 Sep 2026): option B — STACKED / COMPOUNDING.**
  sell_ex_gst = installer_cost x 1.30 (overhead) x 1.05 (inefficiency) x 1.40 (profit)
  e.g. $40/LM carpet -> 40 x 1.30 x 1.05 x 1.40 = $76.44 ex-GST. Owner keeps 28.6% of sell, and he
  accepted that knowingly (was shown the true-40% alternative at $91.00 and rejected it).
  Overhead % and profit % editable globally in Settings AND overridable per price-book item.
  Inefficiency 5% is FIXED — not editable by anyone, not even owner profile.
  All maths deterministic. GST added for customer display only. Blank price != zero.
- **Materials markup: DIFFERENT to labour, % not yet supplied by owner.** Build as its own configurable
  rate (settings key + per-item override), default to the labour chain until he gives the number.
  Do NOT block development on it.

## Price lists received (7 Sep 2026)
Dropbox folder pulled to `/home/user/pricelists/raw/` — 31 supplier PDFs, ~150 pages.
ALL extract cleanly with `pdftotext -layout` — no OCR needed. Every layout is different;
each supplier needs its own extraction rules. Costs confirmed **ex-GST** by owner.

Owner decision (reversing earlier advice): **Terra Ops DOES keep its own material price list.**
Markups to be supplied later, per item — NOT a global %. He will show his current quoting
spreadsheets so the new quoting flow lines up with them.
**Hard requirement, his words: quoting "needs to be super super quick".** Treat speed of the
quoting flow as a first-class design constraint, not a nice-to-have.

### Staleness problem — several lists are far too old to quote from
- Karndean — Aug 2023 (3 yrs old), and it is a RETAIL list with "List price" vs "Your prices"
  (with / without display stand). WHICH COLUMN IS HIS COST IS UNKNOWN — do not guess.
- Polyflor — 2022. Chaparral carpets — Mar 2024. Timberland 2.5 — Nov 2024.
- 2026 and usable: Armstrong (18 May 2026), Arletter EC (1 May 2026), Advantage (May 2026),
  Hurford's Solid (12 Feb 2026), Acoustica (Jan 2026), FDA Forbo (2026).
- 8 files have no detectable effective date in the body.
- `RH Pallet dimension Chart.pdf` is not a price list at all (pallet dimensions).
- `PriceList_STANDARD-1 / -3 / -12` — supplier not identifiable from the file, needs owner to name them.
- `Terra Flooring PL March 2025.pdf` is HIS OWN WHOLESALE SELL list, not a supplier cost list.
  Do not import it as cost.

## Price list answers from owner (7 Sep 2026)
- He buys from **ALL 31** suppliers. Told him: batches, current lists first, Armstrong as pilot.
- **PriceList_STANDARD-1 / -3 / -12 = BELGOTEX.**
- **Terra Flooring PL March 2025.pdf is a SUPPLIER cost list — supplier is CHAMELEON FLOORING.**
  (Not his own sell list, correction to earlier assumption.) He said he screenshotted proof but
  the attachment did NOT arrive — chase it.
- **Karndean cost column — SOLVED, do not guess:** he has display stands on SOME ranges, not all.
  Import BOTH "Your prices" columns per range (cost_no_stand, cost_with_stand) + a per-range
  `hasDisplayStand` boolean that selects which is live. "List price" stored as retail only, never cost.
  NOTE: nothing is actually redacted in the PDF he sent — all 3 columns extract fine.
- **RANGE / COLOUR MODEL — DECIDED (his question, my call, he was told):**
  Range is the priced entity. Colours are variants underneath and inherit the range price.
  Per-variant price override for real exceptions (e.g. Karndean Art Select: Oak Royale $68.80/m2
  vs Parquet $76.53/m2 — same range). Quoting = pick range, price instant; colour recorded on the
  job and does NOT affect price. Never make him scroll hundreds of colours to get a number.
- **Belgotex forces price validity dates:** clearance prices with hard expiry
  (Academia Flexbac $9.90 ends 30/09/2026 then $28.90; Equinox $15.50 ends 31/10/2026) and the
  sheet states all prices valid 30 days. So price rows need effective_from + valid_until, and the
  quoting engine must WARN when a line uses an expired price. Never silently quote a dead clearance rate.
  Belgotex also has two backings (Flexbac / Probac) at different prices -> variant-with-own-price.
- Belgotex supplier fee seed: handling fee $50 per pallet; delivery free into store.

## Armstrong pilot parse (7 Sep 2026) — DONE, awaiting owner verification
- Parser: `/home/user/pricelists/parsers/armstrong.py` -> `/home/user/pricelists/out/armstrong.json`
  Verification doc generator: `/home/user/pricelists/parsers/armstrong_doc.py`
  Owner-facing check sheet: `/home/user/armstrong-price-check.report/content.md` (delivered)
- Result: 59 priced rows, 38 colours, 0 unreadable rows. Effective 18 May 2026, ex-GST.
- FOUR silent parser bugs found and fixed during the pilot (proof the raw-PDF-first rule matters):
  1. accessory two-up columns were being read as one product with 2 price columns
  2. the "Various**" Natural Creations LVT ranges were mislabelled as $-per-piece accessories
  3. column-header lines like "(mm) ... (per m2)" were appended onto the previous range name
  4. Appendix 1 "(Polished Grey/Aggregate)" continuation appended to the wrong (last priced) row
- STRUCTURAL findings that the price book schema must support:
  * TWO cost columns per range: pallet price vs single price (Geologic $18.95 vs $20.85/m2).
    Estimator must auto-switch to pallet price when job qty passes pallet m2, and SHOW that it did.
  * Armstrong "Dealer Price" is conditional on credit account + displaying samples — SAME pattern as
    Karndean display stand. Store both, per-range boolean selects the live cost.
    ASK OWNER: does Terra qualify for Armstrong dealer pricing? (Chesterfield $20.60 vs $14.95.)
  * en-dash "–" in a price column = genuinely unavailable, stored as NULL, never 0.
  * Armstrong fees (real, contradicts spec v2 seed which said <=$1000 -> $150 / >$1000 -> $100):
    metro/freight-forwarder delivery $150 per shipment; BUILDING SITE delivery $200 per shipment;
    futile/reschedule $50; split pallet $50 each extra; pickup baling/handling $30; overnight bag
    <5kg $30; storage $7.50/week/pallet; crate return CREDIT $50 each (min 4);
    +15% cutting fee on sheet vinyl less than a full roll; +15% special colour premium.
    Gold Coast is inside their metro zone. Tailgate max 500kg.
    -> spec v2 supplier_fee_rules seed for Armstrong is WRONG, use these.

## Terramater + fuel surcharge (23 Sep 2026)
- WORKFLOW CHANGE (owner's call, accepted): no more bulk Dropbox folder. He sends ONE supplier at a
  time, each as its own spreadsheet, pre-restructured by him in ChatGPT into his own column layout.
  This does NOT match `/home/user/terra-ops-import-template/terra-ops-price-import.csv` (17 cols) —
  Terramater came as 16 different cols. NEVER assume he followed the template; check each file.
  The template stays as the TARGET shape to normalise into, not the upload shape.
- Same validation rule applies regardless of source: arithmetic checks, blanks-never-zero,
  staleness/effective date, range/colour structure, conditional pricing tiers.
- TERRAMATER file: /home/user/Attachments/Terra_Mater_2025_Product_Price_List_0sOkO6.xlsx
  Sheet `Flooring Products`: 104 data rows. Cols: Supplier, Category, Range, Code, Colour,
  Board Size/Thickness, Wear Layer/Veneer, Type/Construction, Boards/Pack, m2/Pack, Packs/Pallet,
  m2/Pallet, Price/m2 (EX GST), Pack Weight kg, Pallet Weight kg, Combined Product Line.
  Categories: Engineered Timber 36, Hybrid 30, Vinyl 20, Laminate 18. 13 ranges.
  ARITHMETIC VALIDATION PASSED: 0 issues / 104 rows. Checked m2/pack = boards x L x W,
  m2/pallet = packs x m2/pack, pallet wt = packs x pack wt, and every row priced.
  Sheet `Source & Notes`: source Terramater_Price_List_2025_.pdf, EFFECTIVE 1 APRIL 2025,
  per m2 ex-GST, freight excluded, flooring only (accessories/adhesives/underlay excluded),
  WildOak "14/2mm" split into separate thickness + veneer columns by whoever built the sheet.
  -> STALENESS FLAG: 1 Apr 2025 is ~18 months old. Ask for something current before activating,
     especially as he's layering new surcharge/fee structure on top of it.
  -> Terramater's 13 ranges with colour rows underneath sharing one range price CONFIRMS the
     locked range/colour model generalises across wildly different sheet layouts.
- NEW SCHEMA REQUIREMENT — FUEL SURCHARGE (not in spec v2, not built yet):
  * per-supplier TOGGLE (bool) + EDITABLE PERCENTAGE, admin-changeable without a code change
  * applied as a % of the TOTAL invoice, not per line item
  * Terramater currently 2% (was 1.2%, supplier raised it). "a few suppliers are doing this now"
  * so: `suppliers.fuelSurchargeActive` bool + `suppliers.fuelSurchargePct` numeric, or a row shape
    alongside supplier_fee_rules. Must be storable history-safe (rate changes over time).
- TERRAMATER per-order fees (order-level, NOT per line — same shape as Armstrong's fee schedule):
  * baling $30 + GST per order
  * delivery South Australia -> Gold Coast warehouse $100 per order
    (he said "i think they are" re: SA origin — confirm, don't treat as gospel)
- Owner has NOT yet confirmed these restated numbers. Do that before building.
- BUILT 23 Sep 2026: `suppliers` + `supplier_fee_rules` tables (schema.ts), `routes/suppliers.ts`
  (list/get/create/update, setFuelSurcharge, fee CRUD, quoteOrderCost), `queries/suppliers.ts`,
  `pages/suppliers.tsx`, nav entry "Suppliers". db:push done. Seeded REAL data via
  `packages/web/src/api/database/seed-suppliers.ts` (idempotent on code): Terramater (2% fuel
  surcharge ON, baling $30+GST, SA delivery $100), Armstrong (10 real fees incl. crate-return
  credit and the two +15% percent fees, dealer pricing flag OFF pending his answer), Belgotex
  ($50/pallet handling, free into store).
  Order cost order of operations: goods ex-GST -> auto fees + ticked fees (normalised to ex-GST,
  credits negative) -> fuel surcharge % on goods+fees -> GST once at the end for display.
  Percent fees read off the GOODS total only, never off other fees.
  Price-list staleness warning built in: no date, past valid_until, or >12 months old all warn.
  Fuel-surcharge changes write old -> new into activityLog (entityType "supplier").
- Fixed a pre-existing bug found by mobile typecheck: `forms.ts` selected `schema.jobs.reference`
  which does not exist -> now `schema.jobs.number`. lint/build/web tsc/mobile typecheck all clean.
- 23 Sep 2026, OWNER CALL: Armstrong and Belgotex DELETED from suppliers + supplier_fee_rules and
  removed from seed-suppliers.ts. He is starting the supplier list from scratch, one at a time.
  Terramater is the only supplier record. DO NOT re-seed Armstrong/Belgotex fee data. The Armstrong
  fee schedule and Belgotex handling fee stay recorded in this file as reference only, to be entered
  when/if he sends those suppliers himself.

## 25 Sep 2026 — SUPPLIER 2: RIVERHILL (validated, NOT yet built into schema)
File: Attachments/Riverhill_2025_Product_Price_List_94j-mT.xlsx. 2 sheets, his own layout again.
- `Products`: 71 rows, 8 ranges, 2 categories (Engineered Timber 46, Hybrid 25).
  Ranges/prices ex-GST per m2: iDesign Chevron 75, iDesign Herringbone 66, iDesign15 Oak 59,
  Classique Oak 43, Elegant SPC Hybrid 9.5mm 32, Elegant SPC Hybrid Herringbone 9.5mm 32,
  Elegant SPC Hybrid 6.5mm 24, Engineered Australian Classic 69.
  ONE price per range shared by all colour codes -> range/colour model confirmed a 3rd time.
- ARITHMETIC PASSED, 71/71 rows priced. boards/pack = m2pack / (LxW) resolves to a whole number
  on every range: Chevron 16, Herringbone 16, iDesign15 8, Classique 8, SPC9.5 4,
  SPC Herringbone 18 (1.43 vs 1.42884, m2 rounded to 2dp), SPC6.5 8, Eng Aust Classic 8.
- Eng Aust Classic is RANDOM LENGTH 1820-2100mm -> m2/pack is a RANGE 1.981-2.285 (136 wide),
  2.621-3.024 (180), 2.766-3.192 (190). Checked: both ends divide to exactly 8 boards, so the
  range is internally consistent. DO NOT ask him for a fixed size. Store min/max length +
  boards_per_pack 8 + min/max m2 per pack.
  *** QUOTING RULE: pack count must be calculated off the MINIMUM m2/pack, never the max or an
  average, or we under-order by up to 13% on this range. Same rule for any random-length product.
- Blank `Wear Layer / Veneer` on all 25 hybrid rows SELF-RESOLVES - the thickness notation carries
  it: "7.5+2" = 7.5mm core + 2mm wear, "5+1.5" = 5+1.5mm. Sums match the range names (9.5 / 6.5).
  Nothing to ask him. Parser must read "core+wear" notation, not just "14/3" veneer notation.
- `Bailing Charge Ex GST` blank on all 71 rows AND `Accessories & Charges` last row states
  "No bailing charge stated in supplied 2025 price list". Matches what he told me.
  -> record as CONFIRMED $0, not "unknown". Blank-is-not-zero rule is overridden here by an
     explicit statement from the owner + an explicit note in the sheet.
- NO effective date anywhere in the workbook. No `Source & Notes` sheet (unlike Terramater).
  Only "2025" in the filename. STALENESS: worse than Terramater. Need date or the source PDF.
- All 8 prices are whole dollars. Possible rounding by whoever built the sheet - confirm.
- `Accessories & Charges`: 22 data rows. Profiles per length (2400/3400), stair nosings
  1540/1820/1900, priced each. Underlay HEL-20 and Floor Protection HFP-20 priced $1.50/$3.00
  per m2 but SOLD IN 20m2 ROLLS = $30 / $60 a roll -> purchase unit != sell unit, existing rule.
  GAPS: Elegant Hybrid 9.5mm has no Reducer and no Base Channel (6.5mm has both). No trims at all
  for iDesign Chevron, iDesign Herringbone, SPC Hybrid Herringbone, Eng Aust Classic (only stair
  nosing exists for Classique Oak and iDesign15 Oak). Ask.
- NO freight/delivery line on the sheet - consistent with Terra arranging its own transport.

## 25 Sep 2026 — DURABLE FACT: TERRA'S OWN TRANSPORT (two carriers, details to come)
Riverhill does NOT deliver to the Gold Coast warehouse. Terra books its own carrier for them.
This is a DIFFERENT THING to `supplier_fee_rules` (what a supplier charges us) and must NOT be
modelled as a supplier delivery fee row. Needs a new entity: freight carriers Terra books direct.
Two carriers, names/contacts/rates NOT yet supplied ("for later when i give you my transport
peoples details"). Pricing rules he described:
  * CARRIER A: standard pallet rate for a 1.20m x 1.20m pallet footprint, but charges DOUBLE
    PALLET if the boards are 1.80m or more.
  * CARRIER B: does not care about board size - one flat price per pallet.
So the carrier table needs a rule shape that is either flat-per-pallet or size-conditional, and
must be selectable per supplier / per purchase order. DO NOT BUILD UNTIL HE SENDS THE DETAILS.
Riverhill ranges that trip Carrier A's double-pallet rule (length >= 1800mm):
  iDesign15 Oak 1900, Classique Oak 1900, Elegant SPC Hybrid 9.5mm 1820,
  Eng Aust Classic 1820-2100.
Fits a 1.2m pallet: iDesign Chevron 680, iDesign Herringbone 600, SPC Hybrid Herringbone 630.
IN THE GAP, unresolved: Elegant SPC Hybrid 6.5mm at 1540mm - overhangs a 1.2m pallet but is under
1.8m. Biggest hybrid range (12 colours). ASKED HIM where the double charge actually triggers.
Also every profile length (2400 / 3400mm) and the 1820/1900 stair nosings overhang a 1.2m pallet.

## 25 Sep 2026 — TRANSPORT CARRIERS CORRECTED + NAMED (owner answers)
SUPERSEDES the 1.8m threshold noted earlier in this file. THE THRESHOLD IS 1.20m, NOT 1.8m.
Anything OVER 1.20m is oversize. The two carriers Terra books direct:
  * UNIFIED TRANSPORT - FLAT price per pallet, any size, no oversize penalty.
    Has an ELECTRIC PALLET JACK -> SITE DROP-OFFS ARE POSSIBLE. This is its key advantage and
    should drive carrier selection whenever the delivery goes to site rather than the warehouse.
  * JOCKS TRANSPORT - size-conditional, charges more for anything over 1.20m.
    ALSO CARRIES CARPET AND VINYL ROLLS (owner: "which is great") -> only carrier for rolls.
CARRIER SELECTION LOGIC the app needs:
  - carpet / vinyl rolls -> Jocks (Unified not stated as carrying rolls)
  - site delivery (not warehouse) -> Unified (pallet jack)
  - pallets all under 1.20m -> either, compare price
  - any pallet over 1.20m -> Unified likely cheaper (flat), Jocks penalised
RATES STILL NOT SUPPLIED. No dollar figures, no contacts. Still DO NOT BUILD the carrier entity.
REVISED Riverhill oversize picture at the 1.20m threshold - only 3 of 8 ranges fit a 1.2m pallet:
  FITS: iDesign Chevron 680, iDesign Herringbone 600, SPC Hybrid Herringbone 630.
  OVERSIZE (Jocks penalty): iDesign15 Oak 1900, Classique Oak 1900, SPC Hybrid 9.5mm 1820,
    SPC Hybrid 6.5mm 1540, Eng Aust Classic 1820-2100.
  ALSO OVERSIZE: every profile (2400 / 3400mm) and the 1820/1900 stair nosings.
  -> so for most Riverhill orders Unified is the default. Board length drives freight cost, so
     `length_mm` must be a real queryable numeric field on the product, not buried in a size string.

## 25 Sep 2026 — RIVERHILL ANSWERS CONFIRMED
- Price list EFFECTIVE FROM 25 Sep 2026 ("starts from now"). No valid_until. Not stale.
- All 8 range prices are EXACT as supplied, not rounded. Whole dollars are real.
- Trim gaps are GENUINE - not available, do not chase:
  no Reducer and no Base Channel for Elegant Hybrid 9.5mm; NO trims at all for iDesign Chevron,
  iDesign Herringbone, SPC Hybrid Herringbone 9.5mm, Engineered Australian Classic.
  Only trim for Classique Oak and iDesign15 Oak is a stair nosing.
  -> quoting must NOT offer a trim that doesn't exist for the selected range. Trim availability is
     per-range, and absence is real data.

## 25 Sep 2026 — SUPPLIER 3: SUNSTAR QLD COMMERCIAL, MARCH 2026 (validated, NOT yet built)
File: /home/user/Attachments/Sunstar_QLD_Commercial_March_2026_Product_Price_List_xtuTtR.xlsx
Same owner-built 13-column layout as Terramater and Riverhill. Two sheets.

SHEET `Products` — 237 data rows, 26 ranges, 5 categories:
  Engineered Timber 93, Luxury Vinyl Plank 52, Hybrid 49, Laminate 26, Australian Hardwood 17.
  Biggest catalogue so far (Terramater 13 ranges/104 rows, Riverhill 8 ranges/71 rows).
RANGE/COLOUR MODEL CONFIRMED A 4TH TIME: all 26 ranges carry exactly one price shared by every
  colour code underneath. Zero duplicate codes across all 237 rows.
NO BLANK PRICES anywhere — all 237 rows priced. Prices ex-GST (`Price / m² Ex GST`) — 3rd
  confirmation that floorcovering costs arrive ex-GST.

OVERSIZE PICTURE (1.20m threshold) — oversize is the NORM here, 23 of 26 ranges:
  FITS a 1.2m pallet (herringbone formats only): Classic Oak - Herringbone 600,
    Le Parquet - Herringbone 750, Australian Naturals - Herringbone 600, Prism Herringbone 750.
  EVERY plank-format range is oversize, INCLUDING the vinyl planks (1219-1524mm) — NEW, no
    Terramater/Riverhill plank range was vinyl. Vinyl plank oversize is now a real case.

17 ISSUES FOUND — arithmetic NOT clean. Two distinct groups:
 1. UNRELEASED PLACEHOLDER ROWS (not errors): "Prism - Coming Q2 2026" and
    "Prism Herringbone - Coming Q2 2026" have blank code AND blank colour, deliberately — the
    row's own Notes say "Colour/code details not provided in supplied price list". Prism
    Herringbone's board count also doesn't resolve whole (10.0444), consistent with placeholder.
    DECISION NEEDED: hold out of schema until Sunstar publishes codes/colours (expected Q2 2026),
    or import now as inactive/draft. ASKED HIM.
 2. NATURALE PLANK 3.0 (10 colours, NP301-NP312) — EVERY row's boards/pack = 15.0243, not whole.
    3.26 m²/pack / (1.219m x 0.178m) = 15.0243. Repeated across the whole range, not a typo.
    Either m²/pack 3.26 is slightly wrong, or pack is genuinely 15 boards and 3.26 is a rounded
    display figure. Every OTHER range in the file resolves to a clean whole number. ASKED HIM.

BAILING CHARGE: column blank on all 237 rows AND the Accessories sheet carries an explicit row
  'No bailing charge stated in supplied March 2026 price list'. Per the standing override, record
  as a CONFIRMED $0, not a gap. Same pattern as Riverhill — now a repeated supplier policy.

EFFECTIVE DATE: no date sheet, but the filename states March 2026. More current than Terramater's
  April 2025. ASKED HIM to confirm rather than assuming.

SHEET `Accessories & Charges` — 23 data rows. Far more complete than Riverhill's:
  - Trims by finish type (Vinyl Wrapped T/Universal/L/C-Trim, plus a cheaper C-Trim for
    Black/Silver/Champagne). Two scotias: MDF $3.50, WPC $6.50 — both colour matched,
    range-agnostic.
  - 3 underlay/floor-protection lines sold in 20m ROLLS but priced PER m² in the source table:
    FP001 Floor Protection $2.50/m², U01 2mm IXPE Acoustic $3.50/m², U02 3mm Foam Silver $1.50/m².
    PURCHASE UNIT != SELL UNIT confirmed a 3rd time. Self-documented by the sheet's own note.
  - STAIR NOSING PRICED PER NAMED RANGE, not universal — 12 rows, $32-$87, covering Classic
    Hybrid, Maxi Hybrid, Maxi Smooth, Maxi Super 95, Authentic, Vogue, Le Parquet, Classic Oak
    12mm, Classic Oak 14/2mm, Australian Hardwood, Keeta, Eucalyptus Steps, Eucalyptus Steps XL.
    UNLIKE RIVERHILL, trim coverage is BROAD not sparse — a point of difference, not a gap.
  - "CUSTOM STAIR NOSING" — no price, Notes: "Contact Sunstar Orders for quote", "Allow 10 days
    for manufacture & delivery". GENUINE PRICE-ON-APPLICATION ITEM. First one across all
    suppliers. NEEDS A SCHEMA AFFORDANCE distinct from both "blank, ask owner" and "confirmed $0"
    (e.g. price null + priceOnApplication true + leadTimeDays). NOT YET DESIGNED.

## 25 Sep 2026 — SUNSTAR DELIVERS ITSELF (owner confirmed) — DURABLE FACT
Owner: "$110 per pallet to my warehouse".
Sunstar delivery fee row from the sheet: QLD Metro, per-pallet, $110 ex-GST, forklift unloading,
metro zone as determined by Sunstar Flooring couriers. Hand unloading or regional deliveries BY
QUOTE. Customer responsible for unloading equipment; must specify if unable to unload a 1 tonne
pallet.
=> SUNSTAR IS THE FIRST SUPPLIER THAT DELIVERS TO THE GOLD COAST WAREHOUSE ITSELF. Terramater
   (own fees) / Riverhill (Terra books its own carrier) both differ.
=> Build as a real supplierFeeRules row: kind "delivery", basis "pallet", amount 110,
   amountIncludesGst false, autoApply true (warehouse delivery is the default case), condition
   text capturing QLD-metro-only / regional-by-quote / customer-supplies-unloading-equipment /
   1-tonne-pallet caveat.
=> Unified/Jocks carrier logic DOES NOT apply to Sunstar warehouse orders. It only comes back in
   if a Sunstar order ships outside QLD metro or goes direct to site.
=> The 23-of-26 oversize picture therefore does NOT drive freight cost on Sunstar warehouse
   orders — $110/pallet is flat regardless of board length. Oversize still matters for
   site deliveries and for pallet-count planning.

## 25 Sep 2026 — SUNSTAR ANSWERS CONFIRMED + CORRECTION TO MY OWN ANALYSIS
Owner answers:
 - Naturale Plank 3.0: he suggested the width is really 7 inches. CHECKED — 7in = 177.8mm gives
   15.0412 boards, marginally WORSE than the sheet's 178mm (15.0243). Width is not the cause.
 - Prism / Prism Herringbone (Coming Q2 2026): LEAVE THEM OUT until Sunstar publishes codes and
   colours. => 24 live ranges, 235 rows imported (237 minus the 2 placeholder rows).
 - Effective date: MARCH 2026 confirmed.
 - NO fuel surcharge. fuelSurchargeActive false.

CORRECTION — MY EARLIER CLAIM WAS WRONG. I told him Naturale Plank 3.0 was the only range whose
board count didn't resolve whole. It is NOT an outlier. Recomputing every range:
  CLEAN whole numbers (all the engineered timber / herringbone ranges): Classic Oak Builders 8,
    Standard 6, Wide Board 6, Herringbone 28, Vogue 6, Le Parquet Standard 5, Herringbone 18,
    Australian Naturals Herringbone 20, Eucalyptus Steps 10, Eucalyptus Steps XL 5.
  NEAR-WHOLE with the SAME KIND of small rounding as Naturale Plank 3.0:
    Australian Naturals Premier 8.0108, Classic Hybrid 10.0004, Authentic Hybrid 6.0020,
    Maxi Hybrid / Smooth / Super 95 all 4.9893, Adare 4.9906, Keeta 8.9941,
    Eucalyptus Steps Gloss 10.0012, Oatlands 15.9992, Naturale Plank 3.0 15.0243,
    Naturale Plank 5.0 7.9944, Maxi Smooth Builders 2.5 16.0128, Maxi Smooth Residential 7.9944.
  => CONCLUSION: SUNSTAR PUBLISHES ROUNDED m²/PACK FIGURES on its hybrid and vinyl ranges. The
     packs ARE whole numbers. Naturale Plank 3.0 is 15 boards; true area 15 x 1.219 x 0.178 =
     3.2547 m², printed as 3.26. Maxi Hybrid is 5 boards (2.1045 printed as 2.1), etc.
DURABLE SCHEMA RULE (new, applies to every supplier):
  Store BOARDS PER PACK as an INTEGER and DERIVE m²/pack from length x width x board count.
  DO NOT do pack-count arithmetic off the supplier's published m²/pack — it is rounded and will
  drift. Always round packs UP when converting an area to an order. Keep the supplier's printed
  m²/pack only as a display/reference field, flagged as rounded.

## 25 Sep 2026 — SUNSTAR SEEDED
Added `sunstar` to packages/web/src/api/database/seed-suppliers.ts and ran the seeder:
  "updated Terramater (2 fees) / updated Riverhill (0 fees) / created Sunstar Flooring (1 fees)".
Seed carries: effective 2026-03-01, fuelSurchargeActive false, and ONE fee row —
  Delivery to Gold Coast warehouse, kind delivery, basis pallet, amount 110, ex-GST, autoApply,
  condition text holding the QLD-metro-only / regional-by-quote / forklift / customer-supplies-
  unloading-equipment / 1-tonne-pallet caveats.
STILL NOT BUILT (products table does not exist yet): the 235 colour codes, the 23 accessory rows,
  the per-range stair nosings, and the price-on-application affordance for Custom Stair Nosing.

## 25 Sep 2026 — SUPPLIER 4: AIRLAY QLD JANUARY 2025 (validated, NOT yet built)
File: /home/user/Attachments/Airlay_QLD_January_2025_Price_List_Expanded_Colours_xuMxIL.xlsx
DIFFERENT LAYOUT from suppliers 1-3: 10 columns, NO Supplier column, **NO PRODUCT CODE COLUMN AT
ALL**, plus a `Source` column of airlay.com.au URLs (25 distinct). Notes show the file is a BLEND:
pricing/spec from a supplied Jan 2025 price list, colour names filled in from the Airlay website.

SHEET `Products` — 325 data rows, 27 ranges, 7 categories:
  Carpet Tile 151, Carpet Plank 81, Sheet Vinyl 41, Vinyl Plank 26, Vinyl Tile 10, Laminate 10,
  Hybrid 6. NO blank prices. All ex-GST.

*** THE RANGE=ONE-PRICE MODEL BREAKS HERE — FIRST TIME IN 4 SUPPLIERS ***
Price is NOT a property of the range. It varies on FOUR different axes depending on category:
  1. BACKING (carpet tile/plank): PVC vs Cushion Back vs PU Cushion Back.
     Uplift is consistent: PVC -> Cushion Back +$6.00, PVC -> PU Cushion Back +$8.00.
     e.g. Lakeside 18.50/24.50, Sierra 22.50/28.50, Elegance 19.50/25.50, Como 24.50/30.50,
     Nova 25.50/33.50, Pebble 32.50/38.50, Empire 27.50/33.50, Geoform 27.50/33.50,
     Dynamic 31.50/37.50, Altitude 31.50/37.50, Horizon 25.50/33.50.
  2. SIZE (Alpine vinyl plank): 177.8x1219.2 = $25.50, 228.6x1524 = $31.50.
  3. THICKNESS (Rustic laminate): 8mm = $17.50, 12mm = $22.50.
  4. COLOUR (Corporate carpet tile): genuinely per-colour, 8 colours at 8 different prices.
     Passion 27.50 / Dynasty 29.50 / Imperial 29.50 / Graphite 30.50 / Mutual 25.50 /
     Majestic 25.50 / Grey Pearl 24.50 / Black Pearl 24.50 / Zero Walk Off Mat 40.00.
=> SCHEMA CONSEQUENCE: price must live on the VARIANT, not the range. Range price becomes a
   default that a variant can override. The axes (backing / size / thickness / colour) must be
   real fields so quoting can pick a variant. THIS SUPERSEDES the "range is the priced entity"
   note for Airlay-shaped suppliers; ranges 1-3 are just the case where all variants agree.

TERMINOLOGY INCONSISTENCIES that need normalising, do not import raw:
  - "PVC" vs "PVC ONLY" — same backing. "PVC ONLY" means no cushion option exists for that
    range/colour. That is AVAILABILITY data, not a different backing. Must split into
    backing=PVC + cushionBackAvailable=false.
  - "Cushion Back" vs "PU Cushion Back" — two names, DIFFERENT uplift (+6 vs +8). Unclear whether
    these are two real products or loose naming. ASKED HIM.

33 ROWS WITH UNCONFIRMED AVAILABILITY — the file over-expanded the colour list:
  the price list said "SELECT(ED) COLOURS" but every colour was expanded into a row anyway.
  Como cushion 7, Dynamic cushion 7, Altitude cushion 8 (=22 cushion rows), Paragon PVC 11.
  RISK: quoting a colour/backing Airlay will not supply. Must import flagged, not as available.
7 ROWS "MADE TO ORDER": Empire Plank Field/Sovereign/Monarch/Sunrise/Province/Kingdom/Domain
  @ $33.50. No lead time stated. Needs a leadTime/madeToOrder flag.

*** FIRST ROLL GOODS IN THE BUILD — 7 SHEET VINYL RANGES, 41 ROWS ***
  All 2.0m x 20m = 40 m²/roll, priced per m². SuperSafe R10 25.50 (plain) / 27.50 (chip),
  R11 31.50, R12 34.50, AquaSafe 31.50, Marble Effects 19.50, Ultra Crystal 22.50,
  Wood Impressions 21.50. R10/R11/R12 = slip ratings, a real spec field for commercial work.
  => JOCKS TRANSPORT IS THE ONLY CARRIER THAT CARRIES ROLLS. First time that rule bites.
  => Sheet vinyl is bought in LINEAR METRES off a 2m wide roll. Waste is driven by room width vs
     the 2m width, NOT by area. This needs cut planning, NOT the pack-count maths used for
     boards/tiles. Separate quoting path.
  => Purchase unit (40 m² roll) != sell unit (m²). 4th confirmation of that rule.

PACK ARITHMETIC: carpet tiles and planks are all exactly 20 units/box (0.25 m² per unit, 5 m²/box)
  — perfectly clean. Vinyl/laminate show the SAME ROUNDED m²/box drift found at Sunstar
  (Alpine 15.0387 and 8.0083, Oakwood 7.9881, Alpine Artisan 470mm 14.9842) -> confirms the
  standing rule: store boards/tiles per box as an INTEGER, derive m², never quote off printed m².
ONE REAL SIZE ERROR, not rounding: Rustic 8mm is listed 1215 x 194 with 1.90512 m²/box, which
  implies a 1227.5mm board, not 1215. The 12mm resolves to exactly 1215 x 194 (1.41426 / 6).
  The file's own note already warns Airlay's current tech sheet shows a different 12mm size.
  => Rustic 8mm is almost certainly 1227 x 194. ASKED HIM. (Sunstar's Oatlands is 1227 x 187, so
     1227 is a real board length in the market.)

RANGE NAMES COLLIDE ACROSS CATEGORIES: "Oakwood" exists as Vinyl Plank (230x1524, $28.50) AND as
  Hybrid (1500x228x8mm, $26.50). "Alpine" is Vinyl Plank, "Alpine Artisan" is Vinyl Tile.
  => range key must be unique per (supplier, category), NOT per supplier.
NO PRODUCT CODES ANYWHERE — first supplier with none. Need a generated composite key
  (supplier + category + range + colour + backing/size) as the product identity.
STALENESS: January 2025 = 20 MONTHS OLD. Oldest list in the build (Terramater Apr 2025,
  Sunstar Mar 2026, Riverhill Sep 2026). ASKED HIM whether it still holds.

SHEET `Accessories & Charges` — 15 data rows:
  - Oakwood Quads/Scotia 16mm 2400x28mm $7.50, all 6 Oakwood colours.
  - Rustic Quads/Scotia 12mm 2400x28mm $6.60, 5 colours. (Both 2400mm = oversize on the 1.20m
    carrier rule, same as every other supplier's profiles.)
  - WELD ROD, TWO PURCHASE MODES FOR THE SAME ITEM: $170 per 100m reel OR $2.00 per metre cut.
    No colour names given. Weld rod is a DEPENDENT accessory on sheet vinyl - driven by linear
    metres of seam, so quoting sheet vinyl must pull weld rod in automatically and pick the
    cheaper mode (break-even is 85m: above that, buy the reel).
  - SHEET VINYL CUTTING FEE $30.00 PER CUT. A per-cut charge, new basis. Multiplies with the
    number of drops in a cut plan.
  - METROPOLITAN DELIVERY BUNDLING FEE $85.00 PER DELIVERY. Forklift-equipped metro deliveries,
    ALLOW MINIMUM 72 HOURS. => AIRLAY DELIVERS. basis = ORDER/DELIVERY, not pallet (Sunstar is
    per pallet, Terramater per order). 72h lead time is a real scheduling constraint.

## 25 Sep 2026 — CROSS-SUPPLIER PRICE OVERLAP FOUND (Airlay vs Sunstar) — GENUINELY USEFUL
Airlay and Sunstar sell DIMENSIONALLY IDENTICAL vinyl and laminate. Spec-matched pairs:
  Alpine 177.8x1219.2mm 3mm/0.55 3.26 m²/box  $25.50  <->  Sunstar Naturale Plank 3.0
    1219x178x3.0mm 3.26 m²/box  $15.50   => SUNSTAR $10.00/m² CHEAPER (~39% less)
  Alpine 228.6x1524mm 5mm/0.55 2.79 m²/box    $31.50  <->  Sunstar Maxi Smooth Residential 5.7
    1524x229x5.0mm 2.79 m²/box  $25.95   => SUNSTAR $5.55/m² CHEAPER
    (Sunstar Naturale Plank 5.0, 4.5mm not 5mm, 2.79, is $25.00)
  Rustic laminate 8mm 194 wide  $17.50  <->  Sunstar Keeta 1215x194x8mm $13.75 and
    Eucalyptus Steps 1215x194x8mm $13.75  => SUNSTAR $3.75/m² CHEAPER
CAVEAT TO STATE: the Airlay list is Jan 2025 and Sunstar is Mar 2026, so the vintages differ.
  Airlay's current prices are more likely higher than lower, so the gap is probably real or wider.
  Matching dimensions do NOT prove matching quality/brand tier. Present as worth checking, not
  as proven.
=> BUILD IMPLICATION: the app should surface "same spec, cheaper elsewhere" across suppliers at
   quote time. That is a real feature, not a report. Not built yet.

## 25 Sep 2026 — AIRLAY ANSWERS CONFIRMED (owner)
- Jan 2025 pricing IS STILL CURRENT. priceListEffectiveFrom 2025-01-01, no valid_until. NOT stale.
  => 20 months old and still live, so DO NOT auto-flag a list as stale on age alone. Staleness is
     the owner's call per supplier, never inferred from the date.
- "Cushion Back" and "PU Cushion Back" are TWO GENUINELY DIFFERENT BACKINGS. Keep separate.
  Three distinct backing values for carpet: PVC, Cushion Back (+$6), PU Cushion Back (+$8).
- The 33 "selected colours" rows: IMPORT AS NORMAL, he checks availability at order time.
  Do NOT block them from quoting. Keep the supplier's "selected colours" note visible on the
  variant as a soft warning only.
- Rustic 8mm board size CORRECTED TO 1227 x 194 (owner's call). 1.90512 / (1.227 x 0.194) = 8.00
  boards exactly. The supplied 1215 was wrong. 12mm stays 1215 x 194 (6 boards).
- Delivery fee $85: AUTO-APPLY FOR WAREHOUSE DELIVERIES ("to my warehouse yes"). So autoApply
  true with the warehouse condition stated; site deliveries are not automatic.
  NOTE THE PATTERN NOW CONFIRMED TWICE (Sunstar $110/pallet, Airlay $85/delivery): supplier
  delivery fees auto-apply ONLY to warehouse-destined orders. Site deliveries go through Terra's
  own carriers (Unified/Jocks) instead. This is the general rule, not a per-supplier quirk.

## 25 Sep 2026 — BELGOTEX CARPET TILES (Sep 2026, expanded colours) — ANALYSED, NOT SEEDED
File: Belgotex_Carpet_Tiles_Expanded_Colours_Sep_2026_1y5oxd.xlsx. NOTE: this is a DIFFERENT
dataset from the old Belgotex seed deleted earlier under "starting from scratch". That deletion
still stands; this file does not automatically replace it without the owner confirming.
Sheets: "Carpet Tiles" (118 rows, 12 ranges, all Carpet Tile category) + "Charges" (4 rows).
Columns: Supplier, Category, Range, Colour/Code, Backing, Size, m2/Carton,
  Standard Price/m2 ex GST, Clearance Price/m2 ex GST, Clearance Ends, Notes.

FIRST SUPPLIER FILE WITH CLEARANCE/SPECIALS DATA. And it is ROW-LEVEL, not range- or
supplier-level: 35 rows carry a clearance price + end date, 83 rows do not. All 35 clearance
rows are FLEXBAC backing only — none on ProBac, Cushion Back or PVC. So a special attaches to a
specific colour+backing variant, NOT to a range.
  Academia   7 colours Flexbac  std 28.90 -> 9.90  (65.7% off)  ends 30/09/2026  (5 days away)
  Equinox    3 colours          std 28.40 -> 15.50 (45.4% off)  ends 31/10/2026
  Rhythmic   7 colours          std 28.90 -> 19.90 (31.1% off)  ends 31/10/2026
  Shift      5 colours          std 22.00 -> 15.50 (29.5% off)  ends 31/10/2026
  Smooth     7 colours          std 28.90 -> 15.50 (46.4% off)  ends 31/10/2026
  Terrain    6 colours          std 28.90 -> 18.90 (34.6% off)  ends 31/10/2026
  Granite, Aviator: standard price only, NO clearance. Not an error, just not on special.
All 118 rows have a standard price — no blanks anywhere.

BACKINGS: 4 distinct — Flexbac (54), ProBac (54), Cushion Back (5, Monash-Cushion only),
PVC (5, Monash-PVC only). SAME VARIANT-PRICING SHAPE AS AIRLAY, not the one-price-per-range
model of Terramater/Riverhill/Sunstar. Confirms two real supplier-file shapes to support.

PACK MATHS: CLEAN. Every tile is 0.25 m2 (500x500 or 250x1000/1000x250) and every range's
m2/carton / 0.25 is a whole tile count (16, 20 or 24). ZERO rounding drift — first file needing
no correction. Still store tiles-per-carton as an integer and derive m2 per the standing rule.

COLOUR NAMES (informational): 6 rows note the Belgotex AU site omits names for 3 Equinox
colours, resolved via a retailer listing to Capricorn / Leo / Taurus. Same sourcing convention
as Airlay (supplied prices + live site colour names). Not a data problem.

CHARGES sheet:
  Handling Fee    $50.00 per pallet
  FIS Delivery    $0.00  "into store from originating city; regional free to customer's freight
                  forwarder" => FREE DELIVERY TO STORE. THIRD distinct delivery-fee shape
                  (Terramater $100/order, Sunstar $110/pallet, Airlay $85/delivery, Belgotex $0).
                  Need owner's call: record as confirmed $0 fee row, or no fee row at all.
  Site Delivery   POA — no figure. SECOND "price on application" instance (first: Sunstar Custom
                  Stair Nosing). The PAO schema affordance is now needed by two suppliers and is
                  STILL UNDESIGNED. Proposed: price null + priceOnApplication true + leadTimeDays.

## 25 Sep 2026 — OWNER'S ASK: SPECIALS ON A TIMELINE (feature request, NOT yet built)
His words: "ok if we have this lets make it on a timeline on specials which goes back to
original price at the end of that date". So: a special has a window (start + end) and the
system MUST revert to the standard price automatically once the end date passes. No manual
step, no risk of quoting an expired clearance price.
CANDIDATE SHAPES (none committed, asking him first):
  (a) clearancePriceExGst + clearanceStartsAt + clearanceEndsAt on the product/variant row,
      with the active price computed AT READ/QUOTE TIME against today. Mirrors the existing
      priceListWarning() pattern in packages/web/src/api/routes/suppliers.ts (compares
      priceListValidUntil vs Date.now()). No cron job physically rewriting prices.
  (b) a separate productSpecials table, one-to-many per product/variant, so past specials are
      history and the current one is just the row whose window contains today. Scales to
      "what was this on special for last quarter" and to stacked/future-dated specials.
Leaning (b) — because the Belgotex data already proves specials are per-variant and dated, and
because (a) can only ever remember one special and loses it the moment it is overwritten.
BLOCKER TO NOTE: NO products ROWS EXIST YET for any supplier. All 4 seeded suppliers are seeded
at supplier + supplierFeeRules level only. The products table (schema.ts ~line 616) has never
been populated, AND still has no variant fields (backing/size/thickness) and no uniqueness
constraint. So the specials timeline has nothing to attach to yet. Two related gaps in the same
table: variant pricing (flagged at Airlay, restated by Belgotex) and the specials window.
=> Either build the products catalogue + variants + specials together in one pass, or design
   specials now and wire it when the catalogue lands. Owner's call.

## 2026-09-25 — Belgotex broadloom file analysed + seeded
File: `Belgotex_Broadloom_Carpet_Current_Ranges_July_2026_vRpCXE.xlsx`
- Sheet `Broadloom Carpet`: 155 rows, 18 ranges, 4 tiers (PREMIUM / QUALITY / TEXTURED / WOOL).
- Priced **per linear metre** (new unit for this price book, everything else was per m²).
- Width 4.0 m for every range except WOOL (Auburn Ridge, Settlers Peak) at 3.66 m.
- No blanks: every row has a colour and a price. No clearances on broadloom — standard prices only.
- Sheet `Charges & Terms`: Bailing $35/roll; requested cut $25/cut (excludes cuts Belgotex initiates);
  FIS delivery $0 into store; site delivery POA — **Damien: "no site delivery at all"**, so not modelled
  as an active fee; minimum order 2.0 lm.
- Fee basis differs from the carpet-tile file on purpose: $50/pallet handling on tiles, $35/roll on
  broadloom. Two fee shapes on the one supplier, one per product type.
- Seeded: `Belgotex: 273 created (118 carpet tile variants + 155 broadloom lines)`, `clearances: 35 created`.

## 2026-09-25 — Specials timeline shipped
- `product_specials` table: dated window (`starts_on`/`ends_on`, inclusive, Brisbane calendar days),
  never deleted — ending early sets `cancelled_at`, so history survives.
- `packages/web/src/api/lib/pricing.ts` resolves today in Australia/Brisbane and picks the live special
  (cheapest if several overlap), else the standard cost. `costPrice` is always the supplier standard —
  a special never overwrites it, which is what makes the revert automatic.
- Warnings at 14 days: red banner on the price book + per-variant countdowns, grouped by range so
  "7 Academia colours end the same day" reads as one event. `specialsExtendRange` bulk-extends a range
  when the supplier rolls a deal over.
- Price book page at `/products`, nav "Price book". Lint + build clean, mutations verified end to end
  (create → live → end now → cancelled in history) and the test row removed afterwards.
- Live right now: 35 clearances, all Flexbac backing. Academia (7 colours, $28.90 → $9.90) **ends
  30 Sept 2026** — 4 days out.

## 2026-09-26 — Margin model corrected (BINDING, overrides earlier specials behaviour)
Damien's call, asked and confirmed directly: **"Don't drop the sell price when cost drops, keep the
normal sell and pocket the margin."**
- The sell price is ALWAYS marked up off the supplier's **standard** cost, never off a special or
  clearance cost. A special only lowers what Terra pays; it never lowers what the customer is quoted.
- `pricing.ts`: `sell = sellExGst(standard)` (not `cost`). New fields on `PricedProduct`:
  `extraMarginPerUnit` (= standard − special cost while live, else 0) and `sellExGstIfPassedOn`
  (what it *would* sell at if the discount were handed over — computed, kept as a future option,
  deliberately not surfaced in any UI).
- Side effect that matters: the quoted price does not lurch upward the day a special lapses.
- The whole price book is reworded and re-toned accordingly — a special reads as a **win in green**
  ("+$19.00 margin", "Buying under standard", "yours to keep"), never as a customer discount in red.
  Range cards lead with the sell range and show the buying cost underneath as a secondary line.
- Verified: sell off standard confirmed server-side (Academia Burbridge Flexbac — standard $28.90,
  paying $9.90, sell still $55.23 ex / $60.75 inc, +$19.00 a m² margin). Total extra margin across all
  35 live specials: $421.00 per unit summed. Lint + build clean, modal and price book checked in browser.
- Still open: Academia (7 colours, $28.90 → $9.90) **ends 30 Sept 2026**. Extend or let it lapse is
  Damien's decision, still unanswered.
- **Resolved 25 Sept:** Damien's call, "forget about the special, make those normal price, I won't sell
  this in a few days". All 7 Academia Flexbac specials ended early (`cancelled_at` stamped, window and
  $9.90 kept in history as "cancelled"). Academia now quotes at the standard $28.90 cost, sell still
  $55.23 ex / $60.75 inc — the sell price never moved either way, which is the whole point of the model.
  Book is now 28 live specials, 0 ending within 14 days, expiry banner cleared.

## 2026-09-26 — Polyflor imported (474 colours) + roll-vs-cut pricing shipped
Source: `Polyflor_Master_Runable_Final_DTNNP6.xlsx` ("Products & Colours" + "Accessories & Charges"),
consumed by `scripts/extract-polyflor.py` → `packages/web/src/api/database/polyflor-data.ts`
(generated, DO NOT hand-edit — re-run the script if Polyflor reissues the list).

**Cost column rules (Damien's call, confirmed):**
- Where the sheet has a **Discount price, that IS the standard cost** — it is his everyday Polyflor
  price, not a dated special. No `product_specials` rows were created for it.
- Where Discount is blank, **Trade price is the standard cost** (36 rows: Expona Simplay / Design /
  Control PUR).
- **Camaro PUR** (30 colours, blank in both columns) — Damien supplied **$38.77/m² flat**, seeded as
  the standard cost, not price-on-application.
- Every row carries a `sourceNote` saying which column its cost came from: discount 408 / trade 36 /
  owner-supplied 30.

**Roll vs cut (BINDING rule):** sheet vinyl comes off a 2m × 20m roll = 40 m² (20 lm).
- Order **≥ one full roll → the WHOLE quantity bills at the roll rate**, offcut included. Damien's own
  example: 46 lineal metres is roll price, not cut price, on all 46.
- Order **< one full roll → the whole quantity bills at the cut rate.**
- Sell price **does** follow cost here, unlike a special: a cut premium is real extra cost on that
  order, so it passes through. A supplier special is the opposite case and never reaches the sell price
  (see the margin model entry above). The two live side by side in `pricing.ts` and do not interact.
- Schema: `cut_cost_price` (Polyflor's shape — a published cut rate), `cut_uplift_pct` (Armstrong's
  shape — a % uplift on the roll rate, built ready, Armstrong not loaded yet), `roll_m2`, plus
  `wear_layer_mm` and `boxes_per_pallet`. `resolveRollCut()` handles either mechanism.
- It also flags **"take the whole roll"** when a full roll costs less than the cut being asked for, with
  the saving and the spare metres, and reports the break-even quantity.

**Seeded:** 475 rows — 274 sheet-vinyl lines with both a roll and a cut rate, 200 boxed LVT lines,
1 accessory (Weld Rod $2.20 per lineal metre, sellable). Identity is `variantKey`
(supplier+band+range+colour+code), NOT Polyflor's code — code `4020` appears on two different products
in their own list. Boxed LVT m²/unit is derived from the printed dimensions, never their rounded m²/box.

**Auto-applied Polyflor charges** (`supplier_fee_rules`, both `autoApply`): Freight **$80 a delivery**
(basis order) and Baling **$20 a roll** (basis roll — it multiplies on a multi-roll order, it is not a
flat $20 an order).

**UI:** price book rows show the cut rate under the roll rate in amber. The variant modal has a
**Roll or cut** panel (quantity in m² or lm) that prices the line and explains the call in plain words.
- Verified in browser on Polysafe QuickLay PUR ($60.05 roll / $71.20 cut): 46 lm → "the WHOLE 92 m²
  bills at the roll rate… no cut premium on the offcut", cost $5,524.60; 18.5 lm (37 m²) → cut rate,
  +$412.55 premium, and "TAKE THE WHOLE ROLL: 40 m² costs $2402.00 against $2634.40 cut — $232.40
  cheaper and 3 m² (1.5 lm) spare". Lint + build clean.
- Book is now **748 variants across 54 ranges, 2 suppliers**.

## Chameleon Flooring loaded — 26 Sep 2026 (supplier id 9, 92 rows)

**THE BLOCKER IS CLEARED.** Damien sent `Chameleon_Flooring_Without_ELSA_Max_UlOWqd.xlsx`, an
owner-curated extract of `Terra Flooring PL March 2025.pdf`. Its **"Source Notes" sheet states
"Supplier shown on document: Chameleon Flooring Pty Ltd"** — that is the confirmation chased across
several sessions and never received as a screenshot. The extractor asserts that line is present and
refuses to run without it, because it is the only proof tying this list to Chameleon.

Pipeline: `scripts/extract-chameleon.py` -> `chameleon-data.ts` -> `seed-products-chameleon.ts`.
Supplier + fee row added to `seed-suppliers.ts` (Chameleon had NO supplier record before today).

**Seeded: 92 rows** — 82 flooring colour lines + 10 trim lines (from 9 sheet rows; one nosing expands
to two ranges). 36 vinyl / 46 hybrid. Book now **1301 variants, 152 ranges, 6 suppliers with stock**.

**9 priced product lines across 4 families** — and the family is NOT the priced entity:
| Product line | Colours | $/m² | Boards/pack |
|---|---|---|---|
| Elsa | 16 | 19.90 | 12 |
| Elsa Herringbone | 4 | 24.90 | 36 |
| Elsa Acoustic | 5 | 33.90 | 8 |
| Elsa Plus | 6 | 28.90 | 10 |
| Elsa Plus XL | 5 | 33.90 | 8 |
| Pallas 7.5mm | 18 | 28.00 | 6 |
| Pallas Ultimate 9mm | 16 | 33.00 | 4 |
| Pallas Deluxe Herringbone | 4 | 33.00 | 24 |
| Pallas QUANTUM | 8 | 35.00 | 3 |

**Pallas alone runs four different rates**, so `range` = the product line and `tier` = the family
(ELSA / ELSA Plus / ELSA Plus XL / Pallas). A quote that names only "Pallas" is not a price.

**Pack maths:** every line asserted to resolve to a whole board count. One real drift —
**Elsa Plus XL prints 2.601 m²/pack where 8 boards is truly 2.5937**, so ordering off the printed
figure under-orders ~0.3%. Ordering uses the board count, as with Sunstar and Airlay. Pallas QUANTUM's
"3 boards/box" note agrees with the derived count. Pallet columns are empty on every row (asserted).

**Pallas QUANTUM's $35 is NOT supplier-published.** The sheet's own note says "price supplied by user"
and its wear layer is blank. Those 8 rows carry the provenance in BOTH `sourceNote` and
`availabilityNote`, so it reaches whoever is quoting rather than only whoever reads the source trail.

**Trims fit by CORE TYPE, which this workbook does not publish.** The trim notes say "WPC Core",
"SPC Hybrids", "Vulcan Core" — and there is no core column on the flooring sheet to match them to.
Nothing was guessed. Resolved through an explicit, asserted `TRIM_FITS` table:
- `Matching 160mm click stair nosing` -> **Pallas Ultimate 9mm** (doc says "For 9mm Ultimate" — exact, no warning).
- `Matching 115mm click stair nosing` -> **Pallas 7.5mm + Pallas Deluxe Herringbone** (doc says
  "For 7.5mm Deluxe"; both are 7.5mm, only one is "Deluxe" — offered against both, confirm-fit warning).
- `Metal 10mm C Channel` -> **Pallas Ultimate 9mm** (doc states the fit; it is the *colour* that is
  conditional — "All Vulcan colours; will suit 9mm Hybrid if Vulcan colour is acceptable").
- `Matching scotia trims` (WPC), `Matching T, Ramp & End profile` (SPC), `Matching T & Ramp profiles`
  (Vulcan), `Metal 8mm C Channel` (no 8mm floor on the list) -> **universal + confirm-the-core warning**.
- `Matching L angle profile`, `Metal 2cm x 1cm L Trim` -> genuinely universal, no warning.
**"Vulcan" is not a retained range at all**, so the $16.50 T & Ramp may suit nothing in the current book.

**Not seeded as products:** the **$50 warehouse/admin fee** (order-level) and delivery.

**OPEN QUESTIONS FOR DAMIEN (Chameleon):**
1. **$50 warehouse/admin fee basis is UNCONFIRMED** — the Source Notes sheet gives the amount but not
   whether it is per order, per pallet or per delivery. Seeded as a fee rule with **autoApply FALSE**
   so it cannot quietly put a wrong number on every Chameleon quote. Confirm the basis, then turn it on.
2. **Trim core types** — which product lines are WPC, which are SPC, and is Vulcan anything he stocks?
   Answering collapses four confirm-the-core warnings into real range matches.
3. **Staleness** — March 2025, ~18 months old (same problem as Terramater's Apr 2025 list). Re-confirm
   before quoting off it.
4. **ELSA Max** — dropped deliberately per the filename and Source Notes, but confirm it is discontinued
   rather than pending.
5. **Pallas QUANTUM** — confirm the $35 and get its wear layer.

**Goods are ex Brisbane with no delivery rate published**, so like Riverhill there is deliberately no
delivery fee row — Terra books its own carrier. Which keeps the standing hard stop live: the
**Unified Transport / Jocks Transport rates and contacts are still outstanding**, and the carrier entity
table must not be built until Damien sends them. That now blocks freight on Riverhill, Sunstar AND
Chameleon.

**Also resolved this session (no action needed):** the Airlay Rustic 8mm size question. The seeded
Airlay supplier record already records Damien's call — *"Rustic 8mm board size corrected to 1227 x 194
by the owner; the supplied 1215 did not reconcile."* The workbook still prints 1215 for both
thicknesses; the 8mm override is deliberate and 12mm stays 1215.

Lint + build clean. Verified in browser at `/products`: Pallas 7.5mm renders $28.00/m² -> $53.51 sell
ex GST, "6 per carton · 1.6817 m²"; Pallas QUANTUM $35.00 -> $66.88. Backup taken (39 tables, 1490 rows).

## Airlay price book actually loaded — 26 Sep 2026 (supplier id 6, 338 rows)
The Airlay supplier record and its two fee rules (delivery $85, sheet-vinyl cutting $30) had existed
since 25 Sep, but **the products were never loaded — the supplier sat on 0 product rows**. Found by
querying the live DB, not by reading notes. Now extracted and seeded: `scripts/extract-airlay.py` ->
`packages/web/src/api/database/airlay-data.ts` -> `seed-products-airlay.ts`. 325 floor lines + 13
accessories = 338, idempotent on `variantKey` (re-run: 0 created, 338 updated). Every claim in the
supplier record's `notes` was validated against the workbook before any code was written.

**FIRST SUPPLIER WHERE PRICE IS NOT ONE-PER-RANGE.** The same range+colour costs different amounts by:
- **backing** — +$6 Cushion Back, +$8 PU Cushion Back over the PVC base (audited across every row)
- **size** — Alpine $25.50 at 177.8x1219.2mm vs $31.50 at 228.6x1524mm
- **thickness** — Rustic $17.50 at 8mm vs $22.50 at 12mm
- **per colour, for Corporate alone** — 9 distinct rates from $24.50 to $46.00 inside one range
So `backing` is stored as a real price axis and is part of the variant key, not a spec string.

**"PVC ONLY" is an availability flag, not a backing.** 13 rows print it; normalised to `PVC` with the
restriction moved into `notes` ("no cushion-back option"), keeping `backing` clean for pricing.

**Range names collide across categories.** "Oakwood" is both a Vinyl Plank ($28.50, 230x1524mm, 5mm)
and a Hybrid ($26.50, 1500x228mm, 8mm, IXPE underlay) — sharing all six colour names. The extractor
asserts Oakwood is the *only* such collision, so a new one fails the parse instead of mis-keying.
Category is mandatory in the variant key.

**Pack drift goes BOTH directions here** (Sunstar and Chameleon only ever over-ordered). Verified in
the seeded DB: Alpine 177.8x1219.2 prints 3.26 vs true 15x0.216774 = 3.25161 (over-orders), while
Oakwood vinyl prints 2.80 vs true 8x0.35052 = 2.80416 and Alpine Artisan prints 3.31 vs true 3.3135
(both **under-order**). Ordering uses the integer unit count, never the printed m²/pack.

**41 sheet-vinyl roll lines — first roll goods on this supplier.** All 2.0m x 20m = 40 m²/roll, priced
per m², R10/R11/R12 rated. `rollM2` is the cut threshold; `cutCostPrice` and `cutUpliftPct` are
deliberately **null** because Airlay charges a flat $30 per cut (already a fee rule) rather than a
different per-m² rate — filling them would double-charge.

**One pricing anomaly kept, not normalised away:** Corporate/Dynasty PU Cushion Back is +$6 over its
PVC base where every other PU Cushion Back on the list is +$8. Held in an explicit exceptions table;
the extractor fails if any *other* row breaks the +$6/+$8 pattern. The note rides on that row's
`availabilityNote` so it surfaces at quote time.

**Accessory fits resolved explicitly, never guessed** (11 scotia + 2 weld-rod lines): Oakwood scotia
carries a which-Oakwood warning (both ranges share its colour names); Rustic scotia's "12mm" is
probably the scotia's own profile, not the board thickness (the Oakwood scotia's "16mm" is not a floor
thickness either), so it is offered against all Rustic with a warning; weld rods get no fit at all
because Airlay publishes no individual rod colours.

**34 floor lines carry a confirm-at-order warning** (the 33 "selected colours" rows expanded from the
website, per the pattern set on 25 Sep) and **7 are made-to-order**.

**OPEN QUESTIONS FOR DAMIEN (Airlay):**
1. **Rustic 8mm board size — the correction may be on the wrong axis.** Damien's call was 1215 -> 1227
   length. But **1215 x 196mm gives exactly 8 boards** (1.215 x 0.196 x 8 = 1.90512 m², the printed
   figure exactly), so the printed error is more likely the **width**, not the length. Either way the
   box is still 8 boards / 1.90512 m², so **no past order was wrong** — only setout maths is affected.
   Not silently re-decided; the row's note states both readings.
2. **Oakwood Quads/Scotia** — which Oakwood does it suit, the hybrid or the vinyl plank?
3. **Rustic Quads/Scotia "12mm"** — floor thickness it suits, or the scotia's own profile size?
4. **Weld rod colours** — no colour breakdown published; confirm how colour is matched at order time.
5. **Corporate/Dynasty PU Cushion Back at +$6** — pricing error or backing mislabel on Airlay's doc?
6. **Staleness** — Jan 2025, ~21 months old. Damien confirmed pricing "still current" on 25 Sep, but
   that was before anyone knew the products had never been loaded. Worth one fresh confirmation now
   that real Airlay prices are live in the app.

Verified in the DB after seeding: the Oakwood collision resolves to two genuinely different products;
Rustic 8mm's note carries the override and both size theories, 12mm has none; Lakeside/Dune PVC $18.50
-> Cushion Back $24.50 is exactly +$6; the Corporate/Dynasty anomaly note sits on that row only; a
SuperSafe R11 roll line has `rollM2` 40 / `widthM` 2 and all unit-count fields null; all 13 accessory
rows match the fits table. 0 rows with a bad cost price, 0 with an empty variant key.

Lint + build clean. Backup taken (39 tables, 1828 rows — up 338, exactly the Airlay lines).
Supplier row counts now: Terramater 104, Riverhill 92, Sunstar 265, Airlay 338, Belgotex 273,
Polyflor 475, Chameleon 92 = **1639 products**, 35 specials unchanged.

**Hurfords is now the only supplier not loaded.** Two PDFs in `/home/user/pricelists/raw/`, neither
opened yet. Needs asking first: is solid timber quoted per m² or per lineal metre, and the engineered
list (1 Apr 2025) is ~18 months stale and should be re-chased.

## 26 Sep 2026 — FREIGHT PER SUPPLIER SETTLED + 4 NEW ASKS (owner). NO PLAN YET, MORE LISTS COMING

**Owner's instruction: do not plan yet.** He has well more than Hurfords still to send. The plan gets
built once all supplier price lists are in, so scope is not guessed at from a partial set.

### DURABLE FACT — who delivers, per supplier (owner confirmed, supersedes guesswork)
- **Sunstar — delivers to Terra's shop.** Already modelled ($110/pallet fee rule). Nothing to do.
- **Riverhill — does NOT deliver.** Terra's own carriers, Unified or Jocks.
- **Chameleon — does NOT deliver.** Terra's own carriers, Unified or Jocks.
- **Choice between Unified and Jocks depends on PALLET SIZE, decided per order, not per supplier.**
  This confirms why `lengthMm` is a real numeric column: Jocks charges more over 1200mm, Unified does
  not, so the cheaper carrier changes with what is actually on the pallet.

### NEW ASK 1 — the app must ADVISE the cheapest carrier at order time
Not a stored preference, a **calculation per order**: take the accepted job's lines, work out the
pallet(s), then say which of Unified or Jocks is cheaper for that specific consignment and why.
Applies to Riverhill and Chameleon now, and to every future supplier that is ex-warehouse.
**HARD BLOCKER, unchanged and now the single thing holding freight up: the Unified and Jocks RATE
CARDS and contacts are still not supplied.** The comparison cannot be built, let alone trusted, without
both rate cards. Do not invent rates. Do not build the carrier table until they arrive.

### NEW ASK 2 — supplier ordering directory (so orders can be placed once a job is accepted)
Each supplier needs the ordering detail the office actually uses: **ordering email, contact name,
phone, Terra's account number, how they want orders placed, cut-off times, lead time.** Today the
`suppliers` table holds pricing and fee rules but not enough to raise a purchase order.
**Needs from Damien, per supplier.**

### NEW ASK 3 — Xero hookup: what Terra owes each supplier, and when it is due
Owner wants supplier payables visible **on the CRM**, not only in Xero: balance owing per supplier and
the due dates. Read-only sync from Xero is the sane first version — the CRM shows the position, Xero
stays the book of record. Needs Damien to connect the Xero org and confirm which entity (Terra
Flooring only) before anything is wired.

### NEW ASK 4 — supplier credit limits / ordering headroom
Each supplier extends Terra a credit limit, and past it Terra has to pay something down before it can
order again. Owner wants that visible: **limit, current balance, headroom left, and a warning when an
accepted job's order would push past it.** Pairs directly with ask 3 — the balance comes from Xero,
the limit and terms come from the supplier agreement.
**Needs from Damien: each supplier's credit limit and payment terms.**

### What I need from Damien before a plan is worth writing
1. The remaining price lists (he says there are well more than Hurfords).
2. **Unified + Jocks rate cards and contacts** — still the oldest open item, now blocking two suppliers'
   freight and all of ask 1.
3. Per supplier: ordering email/contact/account number, credit limit, payment terms.
4. Xero: which org, and confirmation it is Terra Flooring's book only.
Still open and unchanged: Chameleon's $50 fee basis + trim core types, Terramater re-confirm (Apr 2025),
Hurfords solid timber per m² vs per lineal metre + a current engineered list, Airlay's 6 questions.

---

## 26 Sep 2026 (later) — PACK/LOOSE PRICING ENGINE DONE, ready for plywood

Hurfords plywood prices the same sheet two ways — $23.95 in a full pack of 75, $25.87 loose — which is
the same shape as a vinyl roll vs a cut: one product, two rates, and the ORDER QUANTITY decides. So
`resolveRollCut()` now runs both, rather than a second copy of the arithmetic being written:

- `products.bulk_kind` added (`roll` default, or `pack`). It changes **only the words**, never a number.
  Proved it: pack and roll paths return identical cost and break-even on the same inputs.
- The quote note now reads in the right trade. Pack: *"Under a full pack, so it is loose: $25.87 a
  sheet instead of $23.95 ... TAKE THE WHOLE PACK: 75 sheets costs $1,796.25 against $1,810.90 loose
  — $14.65 cheaper and 5 sheets spare."* No "cut off the roll" nonsense on a sheet of plywood, no
  lineal-metre conversions where they mean nothing.
- Sanity checks that matter to the office: at 69 sheets loose is still right; at **70 sheets the whole
  pack of 75 is $14.65 CHEAPER and you keep 5 spare sheets**. That is Hurfords' own break-even (69.43)
  arriving out of the engine, not typed in.
- Roll goods re-verified unchanged — Polysafe QuickLay still breaks even at 33.74 m² and still says
  take the whole roll at 34 m².
- `bun run lint` and `bun run build` both clean; schema pushed.

~~Still NOT seeded: no supplier rows, no products for Hurfords or Mitre 10 yet.~~ **Superseded — both
are seeded now, see the next section.**

---

## 26 Sep 2026 (later still) — HURFORDS + MITRE 10 ARE IN THE BOOK

Both suppliers now exist and their stock is priceable. **1,682 products across 9 suppliers**, up from
1,639. Fresh backup taken after the writes: 39 tables, 1,875 rows.

### The distinction that drives which one gets the order
Damien's own words, and it is now enforced in the data rather than left to memory:

| | Hurford's | Woodmans Mitre 10 Beenleigh |
|---|---|---|
| Rating | **Non-structural** (CD) | **Structural, T&G, F8** |
| Goes over | **The slab.** Overlay only. | **Joists.** The yellow tongue keys sheet into sheet. |
| Never | cannot span joists | — |

Hurfords does make a joist-rated sheet, but it costs more than Mitre 10's, so joist work goes to
Mitre 10 and slab-overlay work goes to Hurfords. **They are not substitutes for each other no matter
how close the $/sheet looks.** "T&G" is written into the Mitre 10 range name so the two never get
confused in the product list.

### Hurford's — 8 sheets, pack/loose live
CD non-structural pine ply, 8 thicknesses, priced **per sheet** (not per m²) with the 2.88 m² per sheet
carried alongside so a floor area still converts to a sheet count. Every row runs the pack/loose
engine. Worked example straight out of the live database, 12mm:

- 10 sheets → **$348.20**, loose at $34.82 instead of $32.24. A pack only pays for itself above 41.67 sheets.
- 42 sheets → loose is $1,462.44, but **the full pack of 45 is $1,450.80 — $11.64 cheaper with 3 sheets spare.**
- 45 sheets → **$1,450.80**, one full pack, all at the pack rate.

Two problems on the record: the price list is dated **1 Jun 2025, over a year old**, and **freight was
never stated in it** — the freight rule is deliberately left switched off with no amount rather than a
guess being put in. Nobody should send a Hurfords order out until both are answered.

### Woodmans Mitre 10 Beenleigh — 35 lines, and 30 of them are stale
One document, two quotes, two different expiry dates — so expiry is now tracked **per product**, not
per supplier:

- **5 structural T&G F8 sheets** (9/12/15/18mm, plus the 25mm SELEX as its own line). One flat rate,
  no pack break — the note says so plainly: *"One rate, whatever the quantity — no quantity break on
  this product."* Quote valid to **21 Oct 2026 — 25 days left.**
- **30 pine mouldings**, priced per whole 5.4m length, never per metre. Their quote **expired 12 Jun
  2026 — 106 days ago.** Every one of those 30 rows opens with `PRICE EXPIRED`. They are still
  quotable, nothing was deleted, but they must not reach a customer quote as-is.
- Of the 30, **6 carry a real premium** over their size band rather than rounding noise, and each says
  so with the dollar figure — e.g. the FJ Ezi Trim Plus 90x18 at $17.95 against $14.58 for the
  cheapest 90x18 profile, **$3.37 dearer. Charge it, that profile genuinely costs more.**

**Mitre 10 delivers themselves: $80 + GST to the shop or the surrounding area, auto-applied.** Unlike
Riverhill and Chameleon, no Unified or Jocks booking is needed on a Mitre 10 order.

### Housekeeping done at the same time
Plywood went into a new **`sheet_goods`** category (Damien's call); mouldings stay as accessories. The
settings page's category dropdown was quietly wrong — it was missing `accessory` while 100 rows already
used it, and carried two categories that exist nowhere. Fixed, because editing a product off a wrong
dropdown silently drops it out of every filter. Lint and build clean after all of it.

### Live action items out of this
1. **Re-quote the Mitre 10 mouldings.** 106 days expired, 30 lines.
2. **Ask Hurfords about freight** — delivery or pickup, and what it costs to Nerang.
3. **Re-confirm the Hurfords plywood list** — Jun 2025 pricing.
4. The Mitre 10 ply quote lapses **21 Oct 2026**; worth re-quoting before it does.

---

## 26 Sep 2026 — ARTIFLOOR IN (supplier 10)

Cleanest list yet: 24 LVP colours, two ranges, one charge, no quantity break. **1,706 products across
10 suppliers.** Lint and build clean, backup taken after the writes (39 tables, 1,902 rows).

| Range | Colours | Board | Wear | Price |
|---|---|---|---|---|
| Timberland 4.5mm | 18 | 1524 x 228mm | **0.5mm** | $24.90/m² |
| Timberland 2.5mm | 6 | 1219 x 228mm | **0.5mm** | $15.90/m² |

One price per range — every colour in a range costs the same. Filed under `vinyl`, where every other
LVP/LVT plank already sits (Polyflor Camaro/Expona, Chameleon Elsa, Sunstar Naturale Plank). Not
`hybrid` — that stays the rigid SPC click boards.

### The thing to tell the sales floor
**The wear layer is 0.5mm on BOTH ranges.** The 4.5mm range costs **$9.00/m² more (+56.6%)** and that
buys a thicker core and a longer board — **nothing else.** The surface a customer walks on is
identical. "The dearer one lasts longer" is the easy thing to say on the phone and on these two
ranges it is simply wrong. It is written on every one of the 24 rows.

### Four colour names exist in BOTH ranges
Coastal Blackbutt, Weathered Oak, Natural Blackbutt, White Washed Oak — **8 rows**, $9.00/m² apart.
So "Coastal Blackbutt" on its own is not a product: AT202 at $24.90 and AT2501 at $15.90 are both
that. The variant key carries the range, and a quote line has to name it.

### ArtiFloor's own carton and pallet m² are wrong, and the error multiplies
Their printed m²/carton rounds **up**, and their printed m²/pallet is that rounded figure **times the
box count** — so the rounding compounds 60-fold:

- 4.5mm: a carton is **2.779776 m²**, printed as 2.79. A pallet is **166.79 m²**, printed as **167.4**.
- **Order a pallet believing 167.4 m² and the floor is 0.61 m² short — nearly two full boards.**
- 2.5mm: carton 3.891048 vs printed 3.9; pallet 217.90 vs printed 218.4.

Every m² in the book is derived from the integer board count. The printed figures are kept in
`packM2Printed` purely so an ArtiFloor invoice can be checked against ArtiFloor's own maths — a
carton at their rounded figure bills $69.47 against a true $69.22.

### Freight flag worth knowing before a Jocks booking
**Both ranges are over-length.** 1524mm obviously, and **the 2.5mm at 1219mm clears 1200mm by 19mm** —
a margin thinner than the board. Jocks charges more above 1200mm, Unified does not. Feeds straight
into the carrier-advice feature once those rate cards arrive.

### Charges
**Picking & packing $40 + GST per order, auto-applied** — ArtiFloor print it on both supplied sheets,
so it hits every order regardless of size; it is not a small-order penalty. Freight row exists but is
deliberately switched off with no amount.

### Ask ArtiFloor
1. **How do these install — glue-down, loose lay or click?** Not stated anywhere, and it decides
   whether adhesive gets quoted alongside the floor. Biggest gap.
2. **Do they deliver, and what does freight to Nerang cost?** Only picking & packing is published.
3. **What date did this pricing take effect?** The file is titled "CURRENT" and carries no date, so
   the supplier's effective-from is deliberately left blank rather than invented.
4. Do they supply trims, stair nosings or adhesive?
5. What do the AT1xx / AT2xx / AT3xx code blocks mean inside the 4.5mm range?

---

## 26 Sep 2026 — VICTORIA CARPETS IN (supplier 13, 91 broadloom colours)

`Victoria_Carpets_Oct_2026_Colours_and_Charges_ONLY_rRYK1a.xlsx` → extractor
`scripts/extract-victoriacarpets.py` → generated `victoriacarpets-data.ts` → `seed-products-victoriacarpets.ts`.
**91 created, 0 updated.** Book now **1,797 products across 11 suppliers**. Lint clean, build clean,
backup taken (39 tables, 1,996 rows).

11 broadloom carpet ranges, priced **per lineal metre ex GST**, one price per range — every colour in
a range is the same money, asserted at parse time so an odd one out fails the parse.

| Range | Code | Colours | $/lm | 40 lm of goods | Baling as % |
|---|---|---|---|---|---|
| TORENCO | 1406 | 9 | $96.40 | $3,856.00 | 0.91% |
| CORTINO | 1408 | 9 | $102.70 | $4,108.00 | 0.85% |
| TAKONA | 2556 | 7 | $131.40 | $5,256.00 | 0.67% |
| ICONIC | 2833 | 8 | $142.70 | $5,708.00 | 0.61% |
| TUDOR TWIST SUPREME | 2869 | 10 | $143.30 | $5,732.00 | 0.61% |
| BEECHFORD | 8218 | 9 | $162.00 | $6,480.00 | 0.54% |
| APPLETON | 2402 | 8 | $164.80 | $6,592.00 | 0.53% |
| ELMVIEW | 1403 | 7 | $166.40 | $6,656.00 | 0.53% |
| TORRIDON | 2541 | 8 | $173.20 | $6,928.00 | 0.51% |
| SONNING | 8050 | 9 | $183.00 | $7,320.00 | 0.48% |
| MACARTHUR | 2552 | 7 | $183.40 | $7,336.00 | 0.48% |

Cheapest to dearest is **1.9x** ($96.40 → $183.40). Note **SONNING $183.00 and MACARTHUR $183.40 are
40c apart** — effectively the same money, so that pair is a look-and-feel choice, not a budget one.

### THE PRICES START 1 OCT 2026 — FIVE DAYS AWAY
Every one of the 91 rows carries "1 Oct 2026" and the file carries **no other date**. So this is
Victoria Carpets' **next** price book, loaded before it takes effect, and **their current rates were
never supplied.**

- Quoting **October work** off these numbers is correct.
- **Checking a September invoice** against them is not — there is nothing in the book to check it with.
- Stored as the supplier's `priceListEffectiveFrom` and written onto every row's note. Deliberately
  **not** put in `priceValidUntil` — that field is the LAST day a cost holds (Mitre 10's lapsed
  quote), and nothing here expires.

### No part-roll premium, and that is PROVEN not missing
The list has two separately-headed price columns — "Roll Price" and "Cut Length Price" — holding the
**same number on all 91 rows**. So a cut length costs the same per metre as a full roll, unlike
Belgotex broadloom or Polyflor sheet vinyl. `cutCostPrice` / `cutUpliftPct` / `rollM2` are all null
and `resolveRollCut` has nothing to resolve. **The office does not need to ring and ask what the cut
rate is** — that is on every row, so nobody wastes the call. The extractor asserts the equality, so
the day Victoria Carpets split those columns the parse fails loudly instead of silently under-quoting.

Still worth **one** confirmation: two identical columns can mean "we genuinely don't charge for a
cut", or it can mean the cut column got filled by copying the roll column. Quoting is the same either
way until they say otherwise.

### Baling is per 40 lm STARTED, and the boundary bites
**"$35 per every 40 lineal metres and part thereof"** = `ceil(lm / 40) × $35`.

| Order | Blocks | Baling |
|---|---|---|
| 40.0 lm | 1 | $35 |
| **40.1 lm** | **2** | **$70** |
| 80.0 lm | 2 | $70 |
| **80.1 lm** | **3** | **$105** |
| 120 lm | 3 | $105 |

On TORENCO, going 40.0 → 40.1 lm buys **$9.64 of carpet and triggers a whole extra $35** — a 363%
surcharge on the tenth of a metre that crossed the line. **Rounding a measure up "to be safe" is free
on every other supplier in this book and is not free here.**

**The fee engine cannot compute this basis.** Its bases are order / shipment / pallet / roll / week /
percent_of_order — none multiplies by a lineal-metre quantity. So the fee row is seeded
**`autoApply: false`** with the real rule written out in `condition`, same call as Chameleon's
unconfirmed $50: a visibly missing fee the office adds at the right multiple beats a quietly wrong one
that says $35 on a 120 lm job owing $105. The lookup table above is also generated into
`VICTORIA_BALING_BLOCKS` so the number can be read off rather than worked out.

**Open decision for Damien:** whether to add a real per-N-unit fee basis to the engine. It touches
`schema.ts` (text column, so no migration), the `suppliers.ts` FEE_BASES + zod, `suppliers.tsx`
dropdown, and needs a lineal-metre input on the order-cost tester. Not started — flagged only.

Also noticed while in there: **Belgotex's "$35 per roll" broadloom baling has the same problem
today.** It is seeded `basis: "roll"` and auto-applies, but `quoteOrderCost` gives `roll` a multiplier
of 1 — so a 3-roll Belgotex order is charged $35 of baling, not $105. **Pre-existing, not introduced
here**, and it would be fixed by the same change.

### ICONIC is not on Victoria Carpets' own Products index
Its 8 colours (Graphite, Boulder, Silver Shadow, Storm, Pearl Grey, Grey Nuance, Slate, Volcanic)
come off a **hosted specification sheet**; the other 10 ranges are on the live site. Priced, so
quotable — carries an `availabilityNote` soft warning, exactly like the Airlay expanded colours.
Never a block; ring before promising it.

### Biggest gap: NO ROLL WIDTH ON ANY LINE
Victoria Carpets publish no roll width, so **lineal metres cannot be converted to m² for any of these
91 products.** Belgotex broadloom carries 4.0m / 3.66m because Belgotex print it. Guessing 3.66m here
because it is a common broadloom width would push an invented number into every area calculation this
supplier touches, so `widthM` is **null** and every row says why. Measure and quote these in lm.

### Ask Victoria Carpets
1. **What is the roll width on each range?** Biggest gap by a distance — without it no m² maths, no
   wastage calc and no comparison against Belgotex on a per-m² basis.
2. **Is cut-length genuinely the same price as roll, or was that column copied?** Two identical price
   columns is either a real policy or a spreadsheet artefact.
3. **What are the current (pre-1 Oct) prices?** Only the future book was supplied, so a September
   invoice cannot be checked.
4. **Do they deliver to the Gold Coast and what does it cost?** Baling is the only charge published —
   no freight rate, no origin, no free-freight threshold. Freight fee row exists, switched off, no amount.
5. **Is there a minimum order quantity?** Belgotex broadloom is 2.0 lm; Victoria Carpets state none,
   so `minOrderQty` is left null rather than borrowed.
6. Roll length, fibre, face weight, backing — none stated, all of it sales-floor material.
7. **Is ICONIC still current?** It is priced but absent from their own Products index.

## 26 Sep 2026 — NFD IN (supplier 14, 219 lines)

`NFD_Arclan_Aug_2026_All_Colours_vcwo7z.xlsx` → `scripts/extract-nfd.py` → `nfd-data.ts` →
`seed-products-nfd.ts`. **219 rows created** (203 floor colours + 16 accessories), 28 ranges,
5 categories. Price list **12 Aug 2026**, the only date in the file.

| Category | Ranges | Colours | Price/m² ex GST |
|---|---|---|---|
| Vinyl plank | 9 | 102 | $12.90 – $46.60 |
| Hybrid | 3 | 28 | $21.00 – $32.90 |
| Laminate | 3 | 28 | $14.90 – $25.90 |
| Engineered timber | 8 | 24 | $41.90 – $77.00 |
| Carpet tile | 5 | 21 | $13.50 – $24.00 |

Plus 13 trims and 3 underlays.

### NO PALLET DISCOUNT — proven, not assumed
Two price columns, "Pallet/Roll" and "Single/Cut", hold the **same number on all 203 floor rows**
(asserted at parse time). **Buying one box costs the same per m² as buying a full pallet.** Nothing is
gained by rounding an order up to a pallet. `cutCostPrice` / `cutUpliftPct` / `rollM2` all null — a
proven no-premium, not missing data.

**The one exception in the whole file** is PERFORMANCE PLUS underlay: **$12.00 bulk vs $16.00 single,
+33.3%.** Seeded `priceOnApplication: true` with both numbers recorded, because its **unit is not
printed either** — $12 for a roll would be absurd next to $40 for CLASSICMAX foam, so it reads as
per-m², but that is a guess and a guess is not a price.

### Biggest gap: THE FILE STATES NO SIZES AT ALL
No thickness, no wear layer, no board/tile dimensions, no boards per box, no AC rating — on **none** of
the 203 rows. Every other resilient supplier in this book (ArtiFloor, Airlay, Polyflor, Sunstar,
Chameleon) publishes at least some of it. Two consequences:
1. "How thick is it?" **cannot be answered from the system.**
2. There is no integer board count, so **NFD's printed m²/box is the only pack figure there is and has
   to be trusted** — it cannot be cross-checked the way Sunstar's and Airlay's rounded m²/pack figures
   were. Recorded in `packM2Printed` with that caveat on every row.

Only exceptions: **LUXE GRAIN 12MM / 8MM**, which name thickness in the range. 20 rows have a
`thicknessMm`; the other 183 have nothing.

### A COLOUR NAME DOES NOT IDENTIFY AN NFD PRODUCT
**28 colour names are used in more than one range at different prices.** Worst is **Spotted Gum**:
REACTION $17.90, DAINTREE - S/G $69.00, DAINTREE XL - S/G $77.00 — a **330% spread**. Flagged on every
affected row. Never order or quote off an NFD colour name without its range.

### Ranges that look like one product twice — only one is explained
| Pair | Price | What differs |
|---|---|---|
| EVOLVE vs EVOLVE PLUS | $18 vs $23/m² | Same 4 colour names, **same product URL on NFD's own site**. Nothing states what PLUS adds. |
| DAINTREE vs DAINTREE XL | $69 vs $77/m² | Same 3 timbers. "XL" implies a bigger board; **no dimension is given**. |
| LUXE GRAIN 8MM vs 12MM | $14.90 vs $25.90/m² | **Explained** — thickness, and it is in the name. |
| BESPOKE vs TRANQUILITY | $32.90 hybrid vs $44.90 LVT | All 10 BESPOKE colour names sit inside TRANQUILITY's 22. **A genuine "same look, cheaper build" pair to sell** if NFD confirm the decors match. |

### DAINTREE is six single-colour ranges on the sheet
`DAINTREE - B/B`, `- S/G`, `- T/O` and the same three for `DAINTREE XL` — the suffix **is** the colour.
Kept as NFD write them, tied together by `tier`. Those 6 rows are also the **only rows in the file with
no boxes/pallet figure**, so a Daintree order cannot be turned into a pallet count. Null, not zero.

### Fees
- **Packing & Admin $75 flat per order** — `autoApply: true`. Unconditional and per order, which is
  exactly what the engine's `order` basis computes, so this one is safe to auto-apply. **It is flat, so
  it savages small orders: 58% on top of 10 m² of CALLOWAY, 15% on 40 m², 1.9% on 300 m².** Two small
  NFD orders in a week cost $150 of packing; one combined order costs $75.
- **Returns Handling & Re-Stocking 25% of returned goods** — `amount: null`, `autoApply: false`,
  deliberately. It is a percentage of goods sent **back**, charged after the fact. `percent_of_order`
  means percent of the order being **placed**, and `quoteOrderCost` has no concept of a return, so no
  basis can express it. Storing 25 there would leave the app **one careless toggle away from adding 25%
  to every NFD quote.** Same call as Victoria Carpets' per-40-lm baling. On 20 m² of spare TRANQUILITY
  ($898) the fee is **$224.50** — measure tight on this supplier.
- **Freight** — row exists, switched off, no amount. Not published.

### Other findings
- **NFD will make a stair nosing for a floor bought somewhere else**: "NON NFD NOSING" in hybrid and
  LVT at **$55 vs $45** for their own — a **$10 penalty for mixing suppliers.** No non-NFD nosing for
  laminate or timber at all.
- Trims have **no bulk rate** on any of the 13 rows — single/cut price only.

### Ask NFD
1. **Whose name is on the invoice — NFD or Arclan?** Every row of all three sheets says "NFD".
   "Arclan" appears **only in the filename**. There is an active company ARCLAN PTY LTD (ABN 82 651 012
   001) and NFD trade as National Flooring Distributors out of Ormeau, so Arclan is most likely the
   invoicing entity — **not confirmed**, and it matters for matching an invoice to this supplier.
2. **Is the no-pallet-discount deliberate, or was the single column copied off the pallet column?**
3. **What are the actual sizes and thicknesses** for every range except the two LUXE GRAINs? Biggest
   gap in the file.
4. **What does EVOLVE PLUS add over EVOLVE?** And what makes DAINTREE XL "XL"?
5. **Do BESPOKE and TRANQUILITY genuinely share decors?** If yes it is a sales tool.
6. **Boxes per pallet for the 6 Daintree lines.**
7. **What unit is PERFORMANCE PLUS priced in, and which of $12 / $16 applies when?**
8. **Freight to the Gold Coast — or is pickup practical?** Ormeau is ~25 min away. `shipsFrom` is
   NFD's published warehouse address, **not stated on the price list**; confirm orders ship from there.
9. **Minimum order quantity and lead times.** Both unstated.

## 26 Sep 2026 — EC CARPETS IN (supplier 15, 236 broadloom colours)

`EC_Carpets_Terra_Flooring_2026_All_Colours_CpHpoU.xlsx` → `scripts/extract-eccarpets.py` →
`eccarpets-data.ts` → `seed-products-eccarpets.ts`. **236 rows created**, 27 ranges, all `category:
carpet`, all **per lineal metre**. Price list **22 Sep 2026** — four days old, **current**, unlike
Victoria Carpets' future-dated book. Australian-made, manufactured in Lonsdale SA.

| Fibre | Ranges | Colours | $/lm ex GST | Ranges with the 25 lm break |
|---|---|---|---|---|
| Solution Dyed Nylon | 14 | 133 | $77.90 – $139.90 | 3 of 14 |
| Pure Wool | 6 | 50 | $144.90 – $249.90 | 1 of 6 |
| Polypropylene | 5 | 37 | $55.90 – $71.90 | 4 of 5 |
| Polyester | 2 | 16 | $97.90 – $106.90 | 2 of 2 |

One price per range — colour never moves the rate (asserted). The fibre goes in `tier`, because on this
supplier **the fibre *is* the grade band**: it is what separates $55.90 from $249.90.

### The 25 lm break is a FLAT $8.00/lm — so it pays best on the CHEAPEST carpet
10 of the 27 ranges publish an "Over 25m" rate, and on **every one of them the discount is exactly
eight dollars a metre.** Not a percentage. Which inverts the usual instinct about volume deals:

| Range | $/lm | Over 25 lm | Discount | Break-even |
|---|---|---|---|---|
| Summit Point (PP) | $56.90 | $48.90 | **14.1%** | 21.49 lm |
| Encounter (PP) | $57.90 | $49.90 | 13.8% | 21.55 lm |
| Woodchester (PP) | $71.90 | $63.90 | 11.1% | 22.22 lm |
| Sky Bridge (PE) | $97.90 | $89.90 | 8.2% | 22.96 lm |
| Dolomites (PE) | $106.90 | $98.90 | 7.5% | 23.13 lm |
| Boucle (SDN) | $134.90 | $126.90 | 5.9% | 23.52 lm |
| Ayrton / Orchard (SDN) | $123.90 | $115.90 | 6.5% | 23.38 lm |
| Dawson Falls (wool) | $186.90 | $178.90 | **4.3%** | 23.93 lm |

**Chasing the 25 m threshold is worth triple on budget polypropylene what it is worth on wool.**

**Seeded as a real roll/cut split — the first carpet supplier here where that applies.** `rollM2` = 25
(the threshold, in lm), `costPrice` = the over-25m rate, `cutCostPrice` = the standard rate. Verified
live through `resolveRollCut` on Summit Point:

```
  10 lm -> $56.90/lm  $569.00    below threshold
  20 lm -> $56.90/lm  $1138.00   below threshold
21.5 lm -> $56.90/lm  $1223.35   ** 25 lm would cost $1222.50 — CHEAPER, saving $0.85
  25 lm -> $48.90/lm  $1222.50   on the break rate
  40 lm -> $48.90/lm  $1956.00
```

So the engine already tells the office **"order 25 and pay less than you would for 21.5"** without
anyone working it out. `betterAsFullRoll` earns its keep on this supplier.

**Known wording wrinkle, not a bug:** `bulkKind` only has `roll` and `pack`, so a 20 lm quote reads
*"Under a full roll, so it is a cut: $56.90 a lm instead of $48.90."* The **numbers are right**, but
EC's reason is **volume, not cutting** — nothing is physically cut off a roll at 24 lm. A third
`bulkKind` ("volume", with its own wording) would fix it: it touches `breakWords`, a WORDS constant and
the `qtyLm` guard in `pricing.ts`, and `bulkKind` is a text column so **no migration**. Not done —
it changes shared wording that Polyflor and Hurfords also use, so it is Damien's call.

### The other 17 ranges get NULL, never an assumed $8
And the blanks are **not random — they track the fibre**: Polyester 2 of 2 and Polypropylene 4 of 5
have the break, but SDN only 3 of 14 and wool only 1 of 6. That reads as **deliberate policy** (EC
discount volume at the budget end, where $8 is material) rather than an unfilled column. Either way,
inventing the rate would put a discount EC never offered into quotes. Every such row says which it is.
**Worth asking: if the break does apply to wool it is $200 on a 25 lm Elmsford job.**

### Biggest gap: NO ROLL WIDTH ANYWHERE IN THE FILE
Every row sells by the lineal metre and **not one states how wide the roll is**, so **lm cannot be
converted to m² for any EC line** — a floor measured in m² cannot be costed off this list without
ringing them. `widthM` null on all 236 rows. Same hole as Victoria Carpets.

**NOT from EC, but strongly indicated:** independent retailer spec listings (Harvey Norman,
Floormania, Goodwood, flooringpros) all state **3.66 m** for Boucle, Orchard and Flinders Gorge — so
3.66 m is very likely the standard nylon roll. **Deliberately not seeded:** a 4.0 m assumption against
a 3.66 m roll **under-orders a job by 9%**. It is the number to put to EC for confirmation, range by
range, wool included.

### Colour code 8104 is two different products $9.00/lm apart
235 of the 236 codes are unique. The exception: **8104 = Dolomites "Madonna" $106.90/lm AND Sky Bridge
"Marlow" $97.90/lm**, both Polyester. A code is what an order gets typed off, so **ordering "8104"
without naming the range is a coin flip.** `variantKey` stays composite (range+colour) so identity is
safe, and both rows carry an `availabilityNote` soft warning — never a block.
**Good news:** unlike NFD, **no colour NAME is reused anywhere in this book**, so range + colour is
always safe to order on.

### Fee — and it looks too cheap for the distance
**Freight & Handling $69.90 per invoice**, `autoApply: true` (unconditional, per invoice, exactly what
the `order` basis computes). The **only** charge EC publish. Flat, so **25% on top of 5 lm of Montrosa
and 0.3% on 100 lm of Elmsford** — consolidate: two invoices cost $139.80, one costs $69.90.

**Confirm it is all-in.** EC manufacture in **Lonsdale SA** — ~2,000 km away, the same state Terramater
ship from, and Terramater charge a 2% fuel surcharge on top. **$69.90 flat to the Gold Coast is cheap
for that haul.** If it turns out to be handling with freight billed separately, this amount is wrong
and **every EC quote is under.**

### Ask EC Carpets
1. **What is the roll width on each range?** Biggest gap. Is 3.66 m right for the nylons, and what
   about the wools? Without it, no m² maths and no per-m² comparison against Belgotex or Victoria.
2. **Does the 25 lm break apply to the 17 ranges that don't show one?** Especially the wools — if it
   does, that is $200 on a 25 lm Elmsford job that is currently being quoted at full rate.
3. **Is $69.90 per invoice genuinely all-in to the Gold Coast**, or is it handling with freight on top?
4. **Is colour code 8104 a typo?** It is on two different Polyester products $9.00/lm apart.
5. **Lead times from SA**, and which site services Queensland — Lonsdale or Melrose Park NSW?
6. **Minimum order quantity.** Unstated (Belgotex broadloom is 2.0 lm; nothing borrowed).
7. **Is there any part-roll cutting charge** beyond simply losing the 25 lm rate?
8. **Do EC supply underlay or accessories?** This file is broadloom and one freight charge, nothing
   else.
9. Face weight, pile height, backing, roll length, ACCS rating — none stated, all sales-floor material.

### Book totals after both
**2,252 products across 13 suppliers.** Backup: **39 tables, 2,464 rows.** Lint and build clean.

## 26 Sep 2026 — BIG PANDA IN (supplier 16, 44 lines)

`Big_Panda_Flooring_Feb_2025_Terra_otVGLw.xlsx` → `scripts/extract-bigpanda.py` →
`bigpanda-data.ts` → `seed-products-bigpanda.ts`. **44 rows created** — 38 floor colours across 5
ranges, 5 trims, 1 underlay. **The smallest and narrowest book in the system:** two categories only,
SPC hybrid and engineered oak. No vinyl, no laminate, no carpet, no carpet tile. Ships from **Acacia
Ridge QLD**, ~45 min up the M1.

| Range | Colours | Board | Build | $/m² cost | $/m² sell | bd/box | m²/box |
|---|---|---|---|---|---|---|---|
| Titan Guard SPC Hybrid 6.5mm | 11 | 1500 × 228 | 5 + 1.5mm | $18.50 | $35.35 | 6 | 2.052 |
| Titan Guard SPC Hybrid 8.0mm | 8 | 1500 × 228 | 6.5 + 1.5mm | $25.50 | $48.73 | 6 | 2.052 |
| Titan Guard SPC Hybrid 10.5mm | 6 | 1800 × 230 | 9 + 1.5mm | $29.90 | $57.14 | 3 | **1.242** |
| Luminous Oak 15/2mm | 7 | 1900 × 190 | 15/2mm | $48.00 | $91.73 | 6 | 2.166 |
| Modern Engineered Timber 14/3mm | 4 | 1900 × 190 | 14/3mm | $59.00 | $112.75 | 8 | 2.888 |
| Modern Engineered Timber 14/3mm | 2 | 2200 × 220 | 14/3mm | **$62.00** | $118.48 | 6 | 2.904 |

**Second-cheapest hybrid in the book** at $18.50/m², behind Sunstar Classic Hybrid at $17.50 — and
both are cheap for the same reason, a thin board. **Zero supplier fees, and that is a confirmed zero,
not a gap:** their own notes sheet says *"Supplier does not deliver, Terra Flooring must arrange its
own transport / pickup"* and *"No baling, packing or dispatch fee."* Nothing to model.

### The named SPC thickness INCLUDES an attached pad — easiest thing in the book to misquote
Titan Guard 6.5mm is a **5mm board with 1.5mm of IXPE stuck to the back.** 8.0mm is 6.5 + 1.5. 10.5mm
is 9 + 1.5. So a competitor quoting "6.5mm SPC" with no attached pad is selling **6.5mm of actual
board**, and the honest Big Panda match for it is **the 8.0mm at $25.50, not the 6.5mm at $18.50** —
$7.00/m², or $700 on a 100 m² job. Sell the pad as the feature it is (no separate underlay to buy or
lay) but **never let the mm number be compared straight across.**

**No wear layer is published on a single one of the 25 SPC rows, and `wearLayerMm` is seeded null on
all of them on purpose** — the extractor throws if that is ever violated. The "+1.5mm" is *underlay*;
calling it wear layer to a customer would be a material misrepresentation. Wear layer (0.3mm domestic
vs 0.5mm light commercial) is the spec a commercial buyer asks for by name and it is simply absent,
as is any AC or commercial rating. The "Surface / Grade" column gives embossing instead — "Random
EIR" on the 6.5mm, "Wood texture" on the 8.0 and 10.5mm — which describes a **look, not durability.**
**Cannot answer "is this rated for a shop" off this file.**

### Titan Guard 8.0mm looks like the same board as AIRLAY OAKWOOD — and Airlay publish what Big Panda don't
| | Big Panda Titan Guard 8.0mm | Airlay Oakwood |
|---|---|---|
| Board | 1500 × 228mm | 1500 × 228mm |
| Build | 6.5 + 1.5mm | "6.5 + 1.5mm build" |
| Pad | attached (IXPE) | IXPE |
| Wear layer | **unpublished** | **0.5mm** |
| Cost | $25.50/m² | $26.50/m² |
| Per box | 6 bd / 2.052 m² | 5 bd / 1.71 m² |

Identical board, identical build split, **$1/m² apart.** Two things follow. Airlay's **0.5mm is the
best available PROXY** for Big Panda's unpublished wear layer — a proxy, **not a fact, and not to be
quoted as one.** And Airlay publishing a "6.5 + 1.5mm build" *plus* a separate 0.5mm wear layer is
**independent proof that the "+1.5" is underlay and not wear.** Worth asking Big Panda straight out
whether it is the same factory product.

### One range where the RANGE NAME doesn't fix the price — the only one in the book
"Modern Engineered Timber / Oak 14/3mm" carries **two rates split by board size**: 1900 × 190 at
**$59.00** (Natural Oak, White Sand, Dark Oak, Light Oak) and 2200 × 220 at **$62.00** (Country Oak,
Cream Oak). Same range, same 14/3mm build, bigger board, $3/m² more. So **"Modern Engineered Timber,
40 m²" is not a quotable sentence without the colour** — it is a $120 swing on that job. The other
four ranges are one rate for every colour (asserted).

### The 10.5mm box is half the size of the others
**1.242 m² against 2.052.** A 100 m² job is **49 boxes** of 6.5mm but **81 boxes** of 10.5mm — 65%
more boxes to load, stack and count for the same floor. With no boxes-per-pallet and no weights
published, that box count is the **only handling signal in the file.**

**Boards per box are recoverable, which is unusual.** No boards/box column, but every printed m²/box
divides by the board area into a whole number, so the count is **derived, not trusted**. Only the
2200 × 220 drifts: 6 boards is **2.904 m²** against a printed **2.900**, so those 2 rows (Country Oak,
Cream Oak) keep the printed figure for invoice cross-checks and the derived one for ordering.

### Freight: carrier already decided, price impossible
**Shortest board in the file is 1500mm, longest 2200mm — every board is over 1200mm, so every Big
Panda order is a Unified order** on board length alone, no per-order maths needed. What **cannot** be
worked out is the price: **no boxes per pallet, no box weight, no pallet weight anywhere.** All 44
rows have `boxesPerPallet` null.

### Accessories: nothing fits the expensive half of the book
All 6 accessory lines are SPC or laminate items. **Both oaks — the $48 and $59/$62 ranges — have no
scotia, no trim, no reducer, no stair nosing from this supplier**, so a Luminous Oak job buys its
trims elsewhere.

| Item | Size | Cost | Sell | Note |
|---|---|---|---|---|
| Scotia PVC/WPC | 2400 × 22 × 12mm | $4.80 | $9.17 | **6.5mm SPC ONLY** — `fitsRange` set, the only one |
| L Angle Trim | 2400mm (6.5 & 10.5) / 2700mm (8mm) | $7.70 | $14.71 | same price, **300mm more trim on an 8mm job** |
| Universal Trim | 2700mm | $17.00 | $32.49 | |
| Reducer | 2400mm | $20.50 | $39.18 | |
| Stair Nosing | 2400 × 115 × 24mm | $27.50 | $52.55 | says **"All Laminate/SPC"** — they sell no laminate |
| SD Trade 2mm Underlay | 50 m² roll | $40.00 | $76.44 | **$0.80/m²**, purpose unstated |

The underlay reads as being for the engineered oak — all 25 SPC lines already have pad attached and
don't need it — **but that is a reading, not a statement.** The Stair Nosing carries an
`availabilityNote` soft warning, never a block. **MDF Scotia is deliberately absent**: Damien
excluded it because Terra doesn't sell it, recorded in `BP_NOTES` so nobody "fixes" the gap later.

### "Natural Oak" is two products 2.3× apart
**Titan Guard 8.0mm SPC at $25.50 and Modern Engineered oak at $59.00** — the same two words for a
plastic plank and a real timber floor. Only the one collision in 38 colours, but a bad one to get
wrong on a quote. `variantKey` stays composite so identity is safe.

### The price list date is an INFERENCE — weakest provenance in the book
There is **no date anywhere in the file**: not on the products sheet, not on the accessories sheet,
not in the notes. **Feb 2025 comes off the filename**, which is Damien's own naming, not the
supplier's print. Contrast NFD (12 Aug 2026 printed on all 219 rows) and Terramater (1 Apr 2025
printed on the list). Whatever the real date, **it is the oldest list in the book** — 19 months at Sep
2026. `BP_PRICE_LIST_DATE_SOURCE = "filename"` in `bigpanda-data.ts` records it as an inference (there
is no supplier column for date provenance, so it lives in the data file and the supplier notes).
**Re-confirm every rate before a
large order and get a dated list.**

### Ask Big Panda
1. **Is Titan Guard 8.0mm the same factory product as Airlay Oakwood?** Identical 1500 × 228, identical
   6.5 + 1.5 build, $1/m² apart. If yes, Airlay's published spec answers Q2 for free.
2. **What is the actual wear layer on the SPC?** Unpublished on all 25 rows. 0.3mm domestic or 0.5mm
   commercial changes what can be quoted for a shop. Airlay's 0.5mm is a proxy only.
3. **What date is this price list?** No date in the file at all — Feb 2025 is off the filename. Send a
   dated one.
4. **How many boxes per pallet, and what does a box weigh?** Without it there is no freight maths, even
   though Unified is already the obvious carrier.
5. **Does the Stair Nosing genuinely fit laminate?** It says "All Laminate/SPC" and there is no laminate
   in this file — shared stock, or is the products sheet incomplete?
6. **Are there trims for the engineered oaks?** Nothing in the accessories sheet fits the $48–$62 ranges.
7. **What is the 2mm underlay actually for?** All the SPC has pad attached already.
8. **Minimum order quantity**, and lead times — is stock held at Acacia Ridge or brought in?
9. **Warranty, domestic and commercial**, and slip rating. None stated.
10. **Do the 6.5mm and 8.0mm share the 1500 × 228 tooling** and therefore the same decor set? The
    colour lists are completely different, which is odd if the board is the same.
11. **Any trade or volume rate?** One flat price per range, no break of any kind published.

### Book totals after Big Panda
**2,296 products across 14 suppliers.** Backup: **39 tables, 2,509 rows.** Lint and build clean.

| Supplier | Lines | | Supplier | Lines |
|---|---|---|---|---|
| Polyflor | 475 | | Victoria Carpets | 91 |
| Airlay | 338 | | **Big Panda Flooring** | **44** |
| Belgotex | 273 | | Woodmans Mitre 10 | 35 |
| Sunstar Flooring | 265 | | ArtiFloor | 24 |
| EC Carpets | 236 | | Hurford's | 8 |
| NFD | 219 | | | |
| Terramater | 104 | | | |
| Chameleon Flooring | 92 | | | |
| Riverhill | 92 | | | |

**Still no plan or roadmap — Damien has more supplier lists coming and wants the roadmap only once
every supplier is in.**

## 26 Sep 2026: SUPPLIER SURCHARGE SYSTEM REBUILT (generic, all suppliers) + CHAPARRAL IN (supplier 17, 22 lines)

Two pieces of work, one triggered the other. Chaparral arrived with a **temporary fuel surcharge
charged per lineal metre**, and the old model could not hold it: a single `fuelSurchargePct` number on
the supplier record. Percentage only, undated, one per supplier. All three of those were wrong, so
the charge model was rebuilt generically first and Chaparral was seeded onto the new model.

### The old fuel field is superseded, not extended
`supplier_fee_rules` now carries every additional charge any supplier levies, **many live at once per
supplier**, each one:

| Field | What it holds |
|---|---|
| `name` | Free text, exactly as the supplier words it (`"Fuel Surcharge"`, `"Baling Charge"`) |
| `active` / `autoApply` | On the books vs actually billed on an order automatically |
| `kind` | `fuel`, `baling`, `delivery`, `handling`, `cutting`, `packing`, `storage` |
| `basis` | `order` (flat $), `m2`, `lm`, `box`, `roll`, `each`, `pallet`, `pct` |
| `amount` | The figure, in the unit the basis names |
| `effectiveFrom` | When it starts |
| `effectiveUntil` | **Nullable. Null means until further notice** |
| `notes` / `condition` | The supplier's own wording, thresholds, and why |

Charges compute off the order quantity, so nobody types a surcharge in by hand. `resolveSupplierCharges`
in `pricing.ts` takes the order (`m2, lm, boxes, rolls, items, pallets, shipments, weeksStored,
transportExGst`), checks each rule's dates against the order date, multiplies by the matching unit
count, and returns every charge itemised plus the ones it refused and why.

**The cost identity, which the UI now shows line by line:**

```
base material cost
  + supplier surcharge(s)        (fuel, per unit or flat)
  + baling / packing             (per roll, per pallet, per order)
  + transport / freight          (the carrier's invoice, not the supplier's)
  = TRUE MATERIAL COST ex GST
```

**A temporary surcharge is never folded into a product's base price.** If it were, the price book
would silently keep charging it after the supplier drops it, and every historical job would be
unauditable. Cost prices stay the supplier's printed rate. Surcharges sit on the supplier with dates.

**Two guards worth knowing about.** A live per-unit charge on an order with **zero of that unit** is
excluded with a written reason instead of printing a `$0.00` line, so a carpet order with no full roll
shows no baling line at all rather than a confusing zero. And the supplier now carries
**`deliversDirect`**: when it is false, that supplier's own delivery charge **cannot be billed even if
somebody ticks it by hand**, because the freight is the carrier's invoice, not the supplier's. Big
Panda was retrofitted with the same flag in the same run (pickup from Acacia Ridge, previously only
written in prose in its notes).

**25 fee rules across 15 suppliers now. Chaparral's 3 are the only dated ones in the book**, and its
fuel rule is the only `fuel` kind and the only `lm` basis. Everything else is undated and either flat
per order or per roll/pallet.

### Chaparral Carpets: 3 ranges, 22 colours, all broadloom, all per lineal metre

`Chaparral_Carpets_Runable_Current_Ranges_2026_No_Natural_Choices_2rId6l.xlsx` (2 sheets, 22 colour
rows + 6 rules rows) → `scripts/extract-chaparral.py` → `chaparral-data.ts` → `seed-products-chaparral.ts`.
List dated **1 June 2026**, ex GST, priced **per broadloom lineal metre**.

| Range | Colours | Cut $/lm (under 20) | Roll $/lm (20+) | Sell $/lm | Break-even | 19 lm penalty |
|---|---|---|---|---|---|---|
| Apartment 2 | 9 | $68.00 | **$58.00** | $110.84 | 17.06 lm | $132.00 |
| Kingston | 7 | $89.00 | $79.00 | $150.97 | 17.75 lm | $111.00 |
| Outback | 6 | $138.00 | **$128.00** | $244.61 | 18.55 lm | $62.00 |

Colours are plain and short: Apartment 2 runs Red, Marlin, Pewter, Silhouette, Slate, Violet, Clay,
Fawn, Gull. Kingston is Ash, Cinder, Dusk, Ice, Midnight, Titan, Ivory. Outback is Bronze, Cloud,
Granite, Opal, Quartz, Smoke.

**A flat $10.00/lm off at the break on all three ranges**, which is the first time a supplier discount
has been a constant dollar figure rather than a percentage. Because it is flat, it is worth **14.7% on
Apartment 2 and only 7.2% on Outback**, so the break matters most on the cheap carpet and least on the
expensive one. Exactly backwards from intuition.

### The 20 lm break is the smallest in the book, and it makes 19 lm a trap
Under 20.00 lm bills at Cut Length, 20.00 lm and over bills at Roll, **applied to the whole quantity,
never averaged, never blended.** So the discount is not a marginal rate, it is a cliff:

| Order | Rate | Goods | Fuel | Baling | **All in** |
|---|---|---|---|---|---|
| 19 lm Apartment 2 | $68.00 cut | $1,292.00 | $38.00 | $20.00 | **$1,350.00** |
| 20 lm Apartment 2 | $58.00 roll | $1,160.00 | $40.00 | $20.00 | **$1,220.00** |

**Buying one more metre saves $130.00.** Anything measuring between about 17 and 20 lm should be
ordered as a full 20, and on Apartment 2 that holds from 17.06 lm up. Verified in code, not on paper:
the check asserts `20 lm all-in < 19 lm all-in`.

Compare the other breaks in the book: **Chaparral 20 lm, EC Carpets 25 lm, Hurford's 20 to 75, Polyflor
40 m².** Cut price is above roll price on all 22 Chaparral rows, same direction as EC (81 rows),
Polyflor (274) and Hurford's (8). No supplier in the book charges less for a cut.

### The fuel surcharge is regressive, and it is the whole reason the charge system got rebuilt
**$2.00/lm, active from 1 June 2026, effective until further notice**, Chaparral's own word is
"temporary". It is applied **after** the cut-or-roll rate is chosen, so it never affects which rate
wins. Flat per metre against very different rates means it bites unevenly:

| Range | Roll rate | Fuel as % of rate |
|---|---|---|
| Apartment 2 | $58.00 | **3.4%** |
| Kingston | $79.00 | 2.5% |
| Outback | $128.00 | **1.6%** |

**Baling is separate at $20.00/roll** and is a genuinely different animal: fuel scales with metres,
baling scales with roll count. **Roll length is unstated in the file**, so on anything over one roll
the roll count is an assumption and the baling total is an estimate. Flagged in the seeded notes.

### Damien's two worked examples, verified against the live database
`packages/web/src/api/database/check-chaparral.ts` loads the real seeded supplier, its real fee rules
and a real Apartment 2 row, and runs them through the same `resolveRollCut` and `resolveSupplierCharges`
the app uses. **Kept in place as a re-runnable regression check**, not deleted, because it pins the
cliff behaviour and the freight refusal.

| Order | Rate chosen | Goods | Fuel | True material cost |
|---|---|---|---|---|
| 15 lm Apartment 2 | $68.00 cut | $1,020.00 | $30.00 | **$1,050.00** |
| 25 lm Apartment 2 | $58.00 roll | $1,450.00 | $50.00 | **$1,500.00** |

Both match Damien's figures to the cent. On the 25 lm, the **whole** quantity bills at the roll rate,
including the 5 lm offcut past the full roll. No cut premium on the remainder.

### Freight: Chaparral's delivery charge is structurally unbillable
**Chaparral does not deliver to Terra.** Stock is on-forwarded through **Jocks Transport**, and Terra
arranges and pays that leg itself, so the carrier's invoice is the freight cost and Chaparral's own
published delivery charge is **not a Terra cost at all**. `deliversDirect` is false on the supplier and
`freightMethod` is "Jocks Transport / on-forwarder".

Their $95-under-12m charge is **on file as a reference row, unticked, and it is refused even if
somebody ticks it by hand.** Tested: the check script forces it on and the engine still returns $0.00
freight with the reason *"Supplier does not deliver to Terra, freight is invoiced by the carrier
instead, so this is not Terra's cost."* Worth noting that the **$95 and the 12m threshold are Damien's
own recollection, not in the workbook**. The file only says do not apply it. Recorded that way in the
rule's notes so nobody later treats the figure as sourced.

### Natural Direction and Brompton are deliberately absent, and that is the file's own decision
The source workbook's Supplier Rules sheet says it plainly: *"Only keep ranges currently shown on
Chaparral website. Natural Direction and Brompton removed."* **There is no price row for either range
anywhere in the file.** Damien's message quoted figures for them ($118/$108 Brompton, $88/$78 Natural
Direction) but **those numbers appear nowhere in the source**, so they were not seeded. They are
recorded in `CHAPARRAL_EXCLUDED_RANGES` with the reason and the quoted figures, purely for traceability,
so the gap reads as a decision rather than a missing import. **If either range is still orderable, it
needs a current sheet from Chaparral.**

### Specs: there are none. This is the thinnest spec sheet in the book
Not one of the 22 rows publishes fibre, construction, pile weight, durability or commercial rating,
warranty, or **roll width**. `widthM` is null on all 22 and `tier` is empty on all 22, deliberately,
and the extractor throws if that is ever violated.

**The missing roll width is the one that actually blocks work.** With no width, **lineal metres cannot
be converted to m²**, so a Chaparral line cannot be price-compared against the m²-priced half of the
book, and no area maths is possible on it at all. Quote it in lineal metres and nothing else until
Chaparral send the width.

### Where Chaparral sits among the broadloom suppliers
| Supplier | lm lines | Cost range $/lm |
|---|---|---|
| EC Carpets | 236 | $48.90 to $249.90 |
| Belgotex | 155 | $69.96 to $214.12 |
| Victoria Carpets | 91 | $96.40 to $183.40 |
| **Chaparral Carpets** | **22** | **$58.00 to $128.00** |

**The tightest band of any carpet supplier: 2.2× top to bottom, against EC's 5.1×.** Second-cheapest
entry point in broadloom behind EC, and **the lowest ceiling in the book at $128.00**. Chaparral has
nothing in the premium half where EC, Belgotex and Victoria all go past $180. A small, deliberately
mid-market book.

### Ask Chaparral
1. **What is the roll width?** Nothing else on this list matters as much. Without it there is no m²
   price, no area maths, and no comparison against the rest of the book.
2. **What is the roll length?** Baling is charged per roll, so the roll count drives the charge and it
   is currently an assumption on any order over one roll.
3. **Fibre and construction on each of the three ranges**, plus pile weight. Nothing is published.
4. **Durability or commercial rating.** Cannot answer "is this rated for a rental or an office" off
   this file at all.
5. **Warranty**, domestic and commercial.
6. **Are part rolls cut to order, or is the Cut Length price for stock already cut?** Changes lead time
   and whether an 18 lm order can even be filled.
7. **When does the fuel surcharge end?** "Temporary, until further notice" is modelled as open-ended.
   A date would let it expire automatically instead of needing a manual switch off.
8. **Is the $2.00/lm fuel figure reviewed on a cycle**, and is baling per roll regardless of roll
   length?
9. **Confirm the direct delivery charge and its threshold.** $95 under 12m is Damien's recollection,
   not in the workbook. It is never applied either way, but the file should hold the real figure.
10. **Lead time and minimum order quantity.** Neither is stated.
11. **Any trade or volume rate beyond the 20 lm break?** One flat $10.00/lm off is all that is
    published, and it is identical on all three ranges, which is unusual enough to be worth asking
    about.
12. **Are Natural Direction and Brompton genuinely discontinued?** The file removed them because they
    are off the website. If they are still orderable, send a current sheet.

### Book totals after Chaparral
**2,318 products across 15 suppliers.** Backup: **39 tables, 2,535 rows.** `supplier_fee_rules` at 25
rows. Lint clean (56 files, 0 errors), build clean, typecheck clean on web and desktop.

| Supplier | Lines | | Supplier | Lines |
|---|---|---|---|---|
| Polyflor | 475 | | Victoria Carpets | 91 |
| Airlay | 338 | | Big Panda Flooring | 44 |
| Belgotex | 273 | | Woodmans Mitre 10 | 35 |
| Sunstar Flooring | 265 | | ArtiFloor | 24 |
| EC Carpets | 236 | | **Chaparral Carpets** | **22** |
| NFD | 219 | | Hurford's | 8 |
| Terramater | 104 | | | |
| Chameleon Flooring | 92 | | | |
| Riverhill | 92 | | | |

**Correction logged:** the seeded notes originally called this "the newest price list in the book". It
is not. Victoria Carpets (1 Oct 2026), Polyflor (26 Sep), Riverhill (25 Sep), EC Carpets (22 Sep),
Woodmans Mitre 10 (21 Sep) and NFD (12 Aug) are all newer than 1 June 2026. The claim was removed from
the extractor, the data file and all 22 product notes, and the rows were re-seeded.

**Correction logged — ROLL WIDTH IS 3.6 m, and finding that out exposed a real bug.** This entry
originally recorded the broadloom width as unpublished and `widthM` as null on all 22 rows, and called
the missing width the single biggest gap on this supplier, because the workbook genuinely does not
print it anywhere. Damien then gave it directly: all Chaparral is 3.6 m wide, and all carpet in the
book is sold per lineal metre, not per m2. The second half of that confirmed the existing model was
already right, EC Carpets, Victoria Carpets, Belgotex broadloom and Chaparral were all seeded `lm`
already, so nothing changed there. The width was the new fact.

Recorded as owner-supplied everywhere it appears, not as printed spec, so nobody later reads it back
off the price file and cannot find it: `CHAPARRAL_ROLL_WIDTH_M = 3.6` plus a
`CHAPARRAL_ROLL_WIDTH_SOURCE` string in the data file, and the provenance repeated in the supplier
notes and all 22 product notes. Worth noting 3.6 m is NARROWER than the 3.66 m most of the trade rolls,
and the error runs the wrong way: assuming 3.66 m under-orders a job by 1.7% and assuming 4.0 m
under-orders by 10%. Kept as a named constant `CHAPARRAL_TRADE_STANDARD_WIDTH_M` and flagged as
something to confirm with Chaparral in writing rather than quietly treated as settled.

What the width unlocks: lm to m2 conversion on this supplier, so its rates can finally be compared
against the m2-priced half of the book. Derived per m2, for comparison only, never to be quoted as
Chaparral's own figures: Apartment 2 $18.89 cut / $16.11 roll, Kingston $24.72 / $21.94, Outback
$38.33 / $35.56. One full 20 lm roll covers 72.0 m2.

**The bug.** Putting a real width on an `lm`-priced product ran a code path that had never once
executed with a non-null width. `lmFromM2(qty, widthM)` was being called on the raw order quantity in
several places, but for an lm-priced product the quantity ALREADY IS lineal metres, so it was dividing
by the width a second time: a 20 lm order was computing as 20 / 3.6 = 5.56 lm. It survived this long
because every lm-priced supplier in the book had a null width, so the broken path always returned null
and never produced a visibly wrong number, just a blank one. Fixed by adding unit-aware helpers
`lmForQty(qty, unit, widthM)` and `m2ForQty(qty, unit, widthM)` in `pricing.ts`, which branch on the
product's own unit, and routing the affected call sites through them: `resolveRollCut`'s `qtyLm` and
`betterAsFullRoll.spareLm`, the roll-size and spare-area text in `rollCutNote`, and `rollLm` plus
`rollBreakEvenLm` in the products route (that last pair matters because Chaparral's `rollM2` field
actually holds 20, the lm break threshold, despite the field name reused across suppliers). Added
`rollM2Covered` to the route for the area a full roll covers.

Both the roll note and the products screen now show whichever unit is NOT the product's own, so
Chaparral reads "20 lm a roll (72 m²)" and sheet vinyl still reads "40 m² a roll (20 lm)". Before the
frontend fix an lm-priced line would have rendered its own number twice, "20 lm a roll (20 lm)".

Verified, not assumed: `check-chaparral.ts` gained assertions that pin the width at 3.6 m, that
`lmForQty(20 lm)` stays 20 and not 5.56, that `m2ForQty(20 lm)` is 72 m2, that the mirror m2 case still
converts down to lm correctly, and that `resolveRollCut`'s `qtyLm` is 20 at 20 lm and 19 at 19 lm. All
21 checks pass, including Damien's original two worked examples and the 19-vs-20 lm cliff, which were
unaffected. DB re-queried directly: 22 rows, `widthM` 3.6 and `size` "3.6m wide" on every one, 0
exceptions. Outback roll rate reconfirmed at $128.00 cut $138.00, an intermediate console line had
suggested $138/$138 and that was a transcription slip, not a data error. Row count unchanged at 22,
this was a data correction and not a new supplier. Lint clean, web typecheck clean. The three
pre-existing zod `.default({})` overload errors under the mobile package's tsconfig are untouched and
unrelated, they sit on query-schema lines nothing here went near.

**Correction logged — BALING IS $20.00 PER ORDER, NOT PER ROLL.** Damien gave it directly and it
overrides the workbook, which words the charge as "per roll" on the Supplier Rules sheet and on all 22
colour rows. That wording is what the fee row was originally modelled on, `basis: "roll"`, so a 3-roll
order was billing $60.00. It is now `basis: "order"` at $20.00 flat, one charge however many rolls or
metres are on the order, so 20 lm and 200 lm both carry $20.00 and no roll count has to be entered
anywhere.

Worth being explicit that this is the OPPOSITE basis to Victoria Carpets, whose baling genuinely is per
40 lm started. Two suppliers, same charge name, different unit. Nobody should copy one treatment onto
the other, so the reason sits in the condition text on both rows rather than only in this file.

It also closes an open question rather than creating one. The workbook publishes no roll length for
Chaparral, so a per-roll charge could never be counted accurately on a large order: the roll count was
unknowable from the data. Flat per order removes the need for it entirely. The "roll length still
unknown" note stays in the supplier record, but it no longer blocks the costing side, it is just a spec
gap. Re-verified with `check-chaparral.ts`, 30 checks, all PASS, including the fuel-plus-baling worked
examples and the 19-vs-20 lm cut/roll cliff.

**Still no plan or roadmap. Damien has more supplier lists coming and wants the roadmap only once
every supplier is in.**

## 26 Sep 2026 — TARKETT IN (16th supplier record, 180 commercial sheet vinyl colours)

Tarkett is the first supplier in the book where the thing that can wreck a job is not the price, it is
**whether the colour exists in the country**. One rate per range, every colour in the range shares it,
and 70 of the 180 colours are import only at 8 to 10 weeks from order. Nothing in the price or the spec
tells you which. So most of the work here went into availability, not costing.

### What is in
180 colours, 8 ranges, all 2 m wide, priced per m2 ex GST off Tarkett custom quote 1210062 dated
09/06/2025.

| Range | Colours | $/m2 | Roll | In stock | Import 8-10 wk |
|---|---|---|---|---|---|
| iQ Granit (New) | 50 | $33.50 | 23 m / 46 m2 | 21 | 29 |
| Ruby 70 | 33 | $22.00 | 25 m / 50 m2 | 14 | 19 |
| Primo Premium | 30 | $24.50 | 25 m / 50 m2 | 19 | 11 |
| iQ Eminent | 26 | $31.50 | 23 m / 46 m2 | 22 | 4 |
| Granit Safe.T | 24 | $34.50 | 20 m / 40 m2 | 17 | 7 |
| Safetred Universal PU | 8 | $32.00 | 20 m / 40 m2 | 8 | 0 |
| Wallgard 2mm | 5 | $22.00 | 20 m / 40 m2 | 5 | 0 |
| Safetred Universal Plus R12 | 4 | $33.00 | 20 m / 40 m2 | 4 | 0 |

110 stocked, 70 import. **The split runs THROUGH the ranges, not between them.** iQ Granit (New) has 21
stocked colours and 29 import-only ones at the identical $33.50, so range-level thinking is no help at
all, the flag has to live on the colour. The three Safetred ranges and Wallgard are fully stocked, all
17 colours between them, which makes them the safe pick on a job with a date on it.

### The availability trio, and why it is three fields and not one
Every product row carries `madeToOrder`, `leadTimeDays` and `availabilityNote` together, and the three
have to agree or the row is meaningless:

- `madeToOrder` is the boolean the office filters and sorts on.
- `availabilityNote` holds Tarkett's own wording, **"8-10 weeks"**, kept in weeks deliberately. That is
  what they said and it is what a customer gets told.
- `leadTimeDays` is 70, the conservative end of 8 to 10 weeks, and exists **for date arithmetic only**.
  Never quote the day figure. The UI says so in as many words wherever it shows it.

`check-tarkett.ts` checks the trio row by row on all 180, not sampled, because a row that loses its
import flag becomes indistinguishable from a stocked one and the office quotes a date it cannot hit.
0 inconsistent rows.

Stock status did NOT come from the pricing quote. It came from the blue Australian-stock badge on
Tarkett's own AU site, read off owner-supplied screenshots. Badge means stocked, no badge means import.
That makes it the softest-sourced fact on this supplier and also the one that moves a delivery date, so
it is recorded as screenshot-sourced everywhere it appears and flagged to re-confirm with Tarkett before
any import colour goes on a job with a date.

### First percent-of-order charge in the book
The 2.1% fuel surcharge is live, temporary by Tarkett's wording, and is **not inside any of the 180
prices**. It is a dated fee rule on the generic charge model built for Chaparral, and it needed a new
basis: `percent_of_order`, the first one. On iQ Granit (New) it is 70c/m2, taking $33.50 to $34.20
effective. A full 46 m2 roll: $1,541.00 goods, $32.36 surcharge, $1,573.36 true material cost.

Being a percentage rather than a per-unit charge, it bills correctly with no m2 or roll count entered at
all, which is checked, and it is correctly refused with reason "Outside its dates" when an order is
dated 08/06/2025, one day before it starts. When Tarkett drop it, one row goes off and 180 prices stay
untouched. That was the whole point of the rebuild.

### Two charges deliberately NOT created
**Resiloop, 9c/m2, is already inside these prices** per the quote's own wording. Adding a fee row would
bill the levy twice. There is no Resiloop row here on purpose, and the check asserts there is none.

**Baling and delivery to the Terra shop are both unpriced.** The source carries both rows, leaves the
amount blank and marks them Active: No with "Enter when known". So no fee row was invented for either,
and the check asserts neither exists. The consequence has to be said plainly rather than hidden: **a
Tarkett order cost is short by whatever freight and baling cost until someone rings them.** A modelled
$0.00 would have read as free, which is worse than reading as missing. This is the top open question on
this supplier.

### Two extraction facts that were nearly data corruption
**45 of the 180 colours have no supplier code** — every Safetred colour and every Ruby 70 "Uno" colour.
Tarkett publish none. The extractor was writing the literal string `"None"` into those sku fields and
into the variant keys, so the key generator was also producing empty segments where a `||` fallback ran
dry. Two colours could have collided. Fixed by rewriting `slug()` to drop empty segments rather than
keep them, and the check now asserts 0 skus equal `"none"`, 0 variant keys containing a `"none"`
segment, 0 keys with an empty segment, and all 180 keys distinct. The blank skus are blank because
nothing was published, not because something is missing. Quote those by range and colour name.

**Wallgard 2mm is wall cladding, not flooring.** Same quote, same 2 m width, same $22.00/m2 as Ruby 70,
but it goes up a wall. Its 5 colours carry a `WALL CLADDING` flag so nobody specifies it as a floor, and
the check confirms all 5 carry it and that 0 non-Wallgard rows carry it by accident.

### The screen now shows availability before it shows price
This was Damien's ask and it is the part he will actually see. `products.tsx`:

- A single `availability()` helper reads the three DB fields and returns a tone, a label and a note. It
  is written for every supplier, not just Tarkett, because `availabilityNote` is a shared field that
  eight other suppliers already use with different meanings: made-to-order reads amber, an expired
  price reads red (Mitre 10's existing wording), stocked reads green, anything else falls back to
  "Check before order" rather than assuming stock semantics from a supplier it was not tested against.
- The colour table now carries a badge under each colour name, so scanning a 50-colour iQ Granit list
  finally distinguishes the 21 you can get next week from the 29 that are ten weeks out.
- The product modal leads with an availability banner placed ABOVE the price-note banner, on purpose:
  availability outranks price for what the office needs to read first. Where a lead time exists it adds
  a muted line, "Allow 70 days when scheduling the job. Planning figure only, quote the supplier's own
  window above."

No API change was needed, the three fields were already flowing through `decorate()`. Checked in the
running app, not assumed: iQ Granit rows render amber "Made to order" and green "In stock" badges
correctly, and the BROWN modal renders the banner with the 8-10 week wording above the cost grid.

### Verified
`check-tarkett.ts` is new, ~215 lines, and every line prints PASS, ending "ALL CHECKS PASSED": the
single fee rule and its basis, percent, dates and auto-apply; no Resiloop row; no invented freight or
baling row; counts of 180 / 8 ranges / 110 stocked / 70 import / 45 blank skus against the data file's
own exported constants; the availability trio on all 180 rows; the per-range stock split on all 8
ranges; prices and roll geometry pinned per range; Wallgard's wall flag; the codeless-colour and
variant-key assertions; the fuel surcharge through `resolveSupplierCharges` including the no-quantity
and out-of-dates cases; and that `resolveRollCut` returns the flat $33.50 at 5, 46 and 200 m2 alike,
because **Tarkett publish no cut/roll break** and one must not be inferred from the suppliers that do.

Book totals after Tarkett: **16 supplier records, 2,498 product lines.** Lint clean, web typecheck
clean. The three pre-existing zod `.default({})` overload errors under the mobile package's tsconfig are
still there and still unrelated, they sit on query-schema lines nothing here touched. Traced this
session to a monorepo resolution mismatch, the web package pins zod 4.3.6 and the mobile tsconfig
extends `expo/tsconfig.base` with no zod override, so it type-checks the same call against different
definitions. Not a regression from this work and out of scope for it.

### Open with Tarkett, in order
1. Baling and delivery to the shop, both unpriced, both currently missing from the order cost.
2. Re-confirm the stocked-vs-import status per colour. It came off website badges in screenshots.
3. A refreshed quote. 1210062 is dated 09/06/2025, 15 months old as at Sep 2026.
4. Whether part-rolls are cut to order or rolls only sell whole, plus thickness, wear layer, acoustic
   rating, warranty and minimum order, none of which are stated.

**Still no plan or roadmap. Damien has more supplier lists coming and wants the roadmap only once
every supplier is in.**

## 26 Sep 2026 — MJS FLOORCOVERINGS IN (17th supplier record, 104 lines across 31 ranges)

Source: `MJS_Floorcoverings_Feb_2026_FINAL_Runable_Six_cR.xlsx`, three sheets, 108 product rows, 7
charge rows, 8 note rows. Printed February 2026, the freshest list in the book. Extractor is
`scripts/extract-mjs.py`, data file `mjs-data.ts`, seed `seed-products-mjs.ts`, check `check-mjs.ts`.

**Book totals after MJS: 17 supplier records, 2,602 product lines.**

### The 17.5% cut-length surcharge is already in the price, and that is provable
The charges sheet prints "Commercial vinyl cut length surcharge, 17.5%, order less than one full roll".
Read straight, that is a fee rule and the app would add it on top of the cut price. It is not. On all 20
commercial sheet rows the printed cut figure equals the printed roll figure times exactly 1.175, to the
cent. The surcharge is the arithmetic that produced the cut column, not a separate charge sitting on top
of it. Seeding a 17.5% rule would have billed it twice on every part-roll of commercial vinyl.

So there is no surcharge rule on the MJS supplier record, and the identity is asserted in two places on
purpose: the extractor refuses to emit a Commercial Sheet row where `roll * 1.175 != cut`, and
`check-mjs.ts` re-derives it from the seeded DB rows after the fact. If MJS ever reprice one column
without the other, both fail loudly rather than quietly changing what a cut length costs.

### Three rates a line, not two
MJS are the first supplier in the book to print three: cut length, full roll, and a third rate for
orders over 300 m2. `volumeCostPrice`/`volumeQty` already existed on `products` and `resolveRollCut`
already resolved all three, so nothing needed building, but this is the first supplier to exercise it
against real data. The split: 20 lines carry all three rates, 70 carry the roll and over-300 pair, 4
carry a single flat rate.

A volume rate only counts when it is strictly below the roll rate. That guard earns its place here: the
**3 weld rods print the same figure in all three columns** ($2.15, $3.00, $2.15 per metre), and the two
matching ones are not a price break. Seeded flat, so the app cannot announce a saving of zero dollars.
Nomad Plus turf is flat for a plainer reason, the list prints one rate for it.

### Freight: MJS deliver to the shop, so a normal order carries none
`deliversDirect: true`. Metro forwarding is a real $85/order charge but only on orders forwarded ex MJS
locations, so it is seeded **unticked** (`autoApply: false`) and bills only when the office picks it.
Same for all three baling charges, $20 a cut length on commercial vinyl, $50 a half roll on residential
sheet, $50 a cut length on Tru Turf. Nearest honest basis fit each: `each` for the two per-cut-length
ones, `roll` for the half-roll one, and the supplier's own wording kept verbatim in the condition text.

**Country forwarding is not modelled at all**, by Damien's call. $85 base plus $0.30/kg on sheet and
turf rolls or $0.10/kg on pallets, and the per-kg leg needs a product weight the list does not publish
on any of the 104 lines. Recorded in the supplier notes so it is not lost if a country job ever comes
up. Terra are on the Gold Coast and buy metro.

### Synthetic turf gets its own category, on purpose
7 Tru Turf lines: Leisure Lawn Elite, Leisure Lawn Plus, Test Wicket, Urban Sport, Nomad Plus, plus the
1.85m variants of Plus and Test Wicket. New `turf` category rather than filing them under vinyl or
carpet, because turf is not a floor covering and should never turn up in a flooring comparison. It is
**priced per lineal metre, not per m2**, and Leisure Lawn Plus and Test Wicket each sell in two widths
at two different per-lm rates, so a per-lm figure is meaningless without the width beside it. Both
widths are separate lines with the width in the range name.

Needle punch went into the existing `carpet` category, 6 lines. It is carpet.

The 4 Safetred lines (Universal R11, Universal Plus R12, Nebula, Quasar) are excluded, Damien's call.
Check confirms zero of them landed.

### 18 blank colours, and the third reason was found the hard way
The seed script refuses to write a blank colour it cannot explain, and on the first run it stopped dead:
`blank colour with no reason recorded: Weld Rod`. The model had two reasons, MJS publish no verifiable
colour list for the range (8 lines), or the colour column just repeats the range name (7 turf lines).
The weld rods are a third thing, there is no colour cell for them in the source at all. They are bought
by code. So `colourNoneInSource` is now its own asserted category, and it can only be true on an
`accessory` row, a blank on a floor line still fails loudly. Final split 8 / 7 / 3. No placeholder
string was invented for any of them.

### One shared-code fix
`resolveRollCut` in `pricing.ts` had 8 real TS errors, `rollRate` was typed nullable but used unguarded
once past the early no-break return. Added an explicit invariant throw right after `hasCutBreak` is
computed, which narrows the type and documents why the path cannot happen (both break paths already
require a non-null base rate). No behaviour change. Re-ran `check-tarkett.ts` and `check-chaparral.ts`
after it, both still pass in full.

### Verified
`check-mjs.ts` prints **150 PASS lines and ALL CHECKS PASSED**: supplier invariants, all 4 rules present
with the right amount, basis and wording and all 4 unticked, no surcharge rule existing, row and
category counts against the data file's own constants, row-by-row price and geometry reconciliation on
all 104 lines, the 17.5% identity on all 20 commercial cut rows, carton-goods invariants, the 8/7/3
blank-colour breakdown, zero made-to-order and zero lead times, Somwall's 2 wall-flagged rows, a normal
order costing goods-only with zero freight until metro forwarding is ticked (then $85), baling refusing
to bill with no quantity and billing $40 for 2 items once entered, and `resolveRollCut` at both
thresholds on real seeded rows (Somplan 350 at 20/44/46/299/300 m2, Tru Plank Timeless at 30/290/300,
all 3 weld rods at 5/50/400 lm).

Then checked through the **real http path the Products page uses**, not just the DB: signed in, called
`/api/rpc/products/list` and `/api/rpc/products/ranges`, and confirmed turf comes back as 7 lm-priced
rows with per-m2 conversions and no phantom volume break, that `turf` is one of the categories the
browse screen derives for itself (so the filter button appears and reads "Synthetic turf" with no
hardcoded list to maintain), that the 3 weld rods come back flat, and that the full 104 and the
3/6/6/7/82 category split match the seed. Scratch login deleted after the run, user and profile counts
back to 5 and 5.

Lint clean, 56 files. Typecheck clean apart from the same 3 pre-existing mobile zod errors in
`routes/products.ts`, untouched and unrelated.

### Ask MJS
1. **Product weight.** It is the single thing blocking country forwarding from being modelled.
2. Whether the over-300 m2 rate is per order or per colour. The list says "over 300m2" and no more.
3. Lead times and stock status of any kind. Nothing is stated, so all 104 lines are seeded as stocked.
4. Roll length on the needle punch and the turf beyond the printed metres, plus minimum order,
   warranty, acoustic ratings, thickness and wear layer where not printed.

**Still no plan or roadmap. Damien has more supplier lists coming and wants the roadmap only once every
supplier is in.**

## 26 Sep 2026 — ARMSTRONG BACK IN (18th supplier record, 350 lines across 31 ranges)

`packages/web/src/api/database/armstrong-data.ts` (extracted, prior session), plus new
`seed-products-armstrong.ts`, a new Armstrong block in `seed-suppliers.ts`, and new
`check-armstrong.ts`. DB now **18 suppliers, 2,952 products** (2,602 + 350), re-queried live after
both seeds ran, not taken from the scripts' own output.

Armstrong was **deleted** on the 23 Sep 2026 owner call, along with Belgotex. This is a fresh supplier
row off a different, later workbook (`Armstrong_Final_Product_Price_List`), not a restore. The old fee
schedule (metro freight $150, building-site $200, futile $50, split pallet $50, baling $30, overnight
bag $30, storage $7.50/wk/pallet, crate-return credit $50, cutting +15%, colour premium +15%) is
**deliberately not revived**, per the standing instruction. The only piece of it that survives is the
cutting fee, and only because this workbook publishes the same +15% itself, as a product-level rate.

### Three price shapes, and two of them answer different questions
| shape | rows | ranges | how it is held |
|---|---|---|---|
| `roll_cut` | 177 | 14 | `costPrice` = full-roll rate, `cutUpliftPct` = 15 |
| `pallet_standard` | 39 | 6 | `costPrice` = **standard** rate, `volumeCostPrice` = pallet rate, `volumeQty` = null |
| `flat` | 134 | 11 | `costPrice` only, no break of any kind |

Categories: vinyl 271, carpet_tile 31, hybrid 24, laminate 24. All 350 lines are per m2, ex GST.

### First live use of `cutUpliftPct` in the whole book
The column was built for Armstrong's shape months ago and no seeded row had ever exercised it.
Armstrong publish a **percentage**, not a dollar cut rate, so `cutCostPrice` is **null on all 350 rows**
and that is correct, not missing data. Polyflor, MJS and Hurford's print dollars and use
`cutCostPrice`; storing both for Armstrong would be two copies of one rate waiting to disagree. The
15% is Armstrong's own workbook formula, every cut cell literally reads `=D{row}*1.15` and the
extractor asserts that on all 177 roll rows, so it is not inferred from a sample.

### The pallet break is seeded DORMANT, on purpose
Armstrong publish the pallet **rate** and nowhere publish the pallet **quantity**. So `volumeQty` is
null on all 39 rows and they bill at the **standard, dearer** rate. That direction is deliberate: a
quote that is accidentally cheap is money out the door, one that is accidentally dear gets questioned
before it is sent. Set `ARMSTRONG_PALLET_QTY_M2` in `armstrong-data.ts` and all 39 go live in one edit,
which `check-armstrong.ts` proves by passing a hypothetical 500 m2 threshold through the resolver.

The premium is not one number, so neither rate is ever derived from the other. Five carpet ranges sit
at about +10% standard over pallet (Sphere Cushion Back +9.98%), Chesterfield at +17.25%. Both printed
rates are stored exactly as printed on every row. A pallet is an **order-size** question, so it lives
in the same columns as MJS's over-300 m2 rate, never in the cut/roll pair.

### No fee rules, and freight is UNKNOWN rather than zero
This workbook publishes no freight, delivery, baling, futile-delivery or storage charge anywhere, so
`fees: []` and Armstrong's order cost is **goods only**. That is a third case, distinct from the two
already in the book: Big Panda's own sheet states they do not deliver (confirmed zero), MJS deliver
free (confirmed), Tarkett's freight is real but unpriced. Armstrong's is a genuine blank.
`deliversDirect: false` with the reason written in prose on `freightNote`, so nobody reads the empty
fee list as "Armstrong deliver free". No fuel row either, unlike Tarkett's 2.1% and Chaparral's $2/lm.

### No SKUs, and four dimension strings left blank
Not one of the 350 rows carries a code. The source has no code column at all, so `sku` is blank
everywhere and identity is `armstrong|range|colour`. Four printed dimension strings are ambiguous and
every one is left blank with a loud note on the row rather than guessed: the Safeguard gauge
("2mm / 1.5mm", 18 rows, two gauges or gauge plus wear layer), the Armalon NG Colours roll width (8
rows, two widths printed), and "various sizes" on the three Natural Creations LVT ranges (33 rows).

Wallflex's 13 rows are flagged `WALL CLADDING — not a floor covering`, the exact same string as
Tarkett's Wallgard and MJS's Somwall, so one search finds every wall product in the book.

Safeguard R10/R11/R12 are three separate ranges at two rates, so the slip rating is chosen before the
price. Accolade Safe is marketed as a safety product with **no R-number printed**, and the rating is
left blank rather than borrowed from a sibling range.

### Verified
`check-armstrong.ts` passes in full. It reads the seeded set back out of the database, then walks the
real pricing path: Accolade Plus $38.37 full roll producing $44.13 cut **off the percentage alone**
(the resolver derives it, nothing seeded it), the $115.20 premium on 20 m2, sell following cost through
to $1,855.26 inc GST, the whole 36.6 m2 roll at $1,404.34, the cliff at 31.82 m2 with 31 m2 still
cheaper cut and 32 m2 flagged "take the whole roll, $7.82 cheaper and 4.6 m2 (2.51 lm) spare",
Safeguard R10 and Wallflex on the same percentage at their own rates, Armalon NG Colours refusing to
invent lineal metres from a width it does not have, Chesterfield holding $14.95 at 10 / 100 / 1,000 and
10,000 m2 with the $12.75 pallet rate on file and unable to fire, Geologic not charging a loose premium
Armstrong never published on a part carton, a flat range identical at 1 m2 and 1,000 m2, and a 100 m2
order costing goods and nothing else with zero excluded because nothing is on file. Last sweep confirms
all 177 roll rows can actually price a cut dearer than a roll.

Lint clean, 56 files. `bun run build` clean, both packages.

### Ask Armstrong
1. **The m2 on one pallet.** The single thing blocking all 39 pallet lines from ever discounting.
2. Whether Terra qualify for dealer pricing, and whether this workbook supersedes the 7 Sep 2026
   pilot entirely. The pilot recorded a $20.60 Chesterfield "Dealer Price" against a then-listed
   $14.95; this workbook prints $14.95 standard / $12.75 pallet and no $20.60 anywhere. Those look
   like two different documents, not a re-read of one.
3. Freight and delivery method. Completely unstated, and not confirmed zero.
4. The Safeguard gauge ambiguity, and what "various sizes" means on the three Natural Creations ranges.
5. Lead times and stock status, minimum order, warranty, acoustic ratings, product weight. None stated.
6. The effective date of the list. There is none in the file, so its age is unknown.

**Still no plan or roadmap. Damien has more supplier lists coming and wants the roadmap only once every
supplier is in.**

## 27 Sep 2026 — HURFORD'S ENGINEERED FLOORING, AND THE $80 CORRECTED

Hurford's second list is in the book: **163 colour/length flooring rows across 17 ranges, 5 Genuine Oak
nosings and mitres, 2 foam underlays**, 170 lines seeded beside the 8 plywood rows of the other
Hurford's list, which are untouched. 23 rates from $56.00 to $115.00/m2 ex GST, effective 1 Apr 2025
and confirmed current by Damien, so no stale flag. It prices **per m2**, which answers the question the
supplier note had left open.

### The $80 is a BROKEN PACK FEE, not delivery
This is a correction, not a new fact. The workbook prints an $80 "Job Lot Fee" against all 163 rows and
describes it two incompatible ways in one rule: $80 "once per order" AND $80 "when quantity for that
product is less than one full pallet". The second reading bills $240 on a three-line short order. It was
first seeded as a flat **delivery** charge on every order. Damien corrected it:

> "Looks like they charge broken pack fee for under a pallet but they don't charge for delivering to my
> warehouse."

So, confirmed with him on three follow-ups:
- **Delivery to Nerang is FREE**, no minimum order. No freight line belongs on a Hurford's order,
  plywood or flooring. `deliversDirect` stays `true`: they do deliver, it just costs nothing.
- **$80 once an order** that does not make a full pallet, never multiplied by the short lines. A
  three-line short order is $80, not $240.
- **The fee is order-level.** A line that does make a pallet does not escape it when it shares an order
  with a short line. The test is whether the ORDER makes a pallet.
- Only an order that is all full pallets avoids it.

Seeded as `kind: "handling"`, `basis: "order"`, $80 ex GST, `autoApply: true`, so it lands in
`packingExGst` and never in `freightExGst`. It auto-applies because a Hurford's pallet is 69.12 to
119.84 m2 and a Terra job is almost never that big, so short of a pallet is the normal case. The office
strikes it off on the rare full-pallet order, and the rule's own `condition` says so, because nothing in
`resolveSupplierCharges` can see what a pallet is. A charge that silently goes missing is worse than one
the office has to remove. The money now differs from the old reading in one place: **a full-pallet order
carries nothing where before it carried $80.**

The old reading's side effects are all gone: the exported constant is
`HURFORDS_BROKEN_PACK_FEE_EX_GST`, no product row says "EXCLUDES DELIVERY" any more, and the per-row
note on all 170 lines now opens "DELIVERY TO US IS FREE, NO MINIMUM ORDER".

### The rate column heading now makes sense
It is headed "Pallet Price $/m2", which read like the cheaper half of a pallet/broken-pallet pair. Under
the corrected reading it genuinely is the pallet rate: going under a pallet costs the **fee**, not a
higher rate per m2. So still one rate per row, no `cutCostPrice`, no volume break, the opposite shape to
Hurford's own plywood which does charge a dearer loose rate per sheet and no fee. Full pallet m2 is
blank on all 163 rows so it is derived, and it now **decides money**, so it is worth confirming with
Hurford's on any order sitting near a pallet.

### Verified
`check-hurfords-timber.ts` passes in full, **200 checks**, up from 175. New ones worth naming: freight
is $0 on every order shape tested, the $80 lands in packing once on a one-box order, once on a
three-line short order and once on a **mixed order carrying a full pallet of First Floors Blackbutt
(88.938 m2) beside a 20 m2 short line**, where it is neither $0 nor $160. An all-full-pallet order still
gets billed by the engine, which is checked honestly and proved to fall to goods only, $0 charges and $0
freight, once the rule is off it. The First Floors 135mm dual spec (14mm $88 vs 13.5mm $81), the 26
handed herringbone/chevron rows, the 42 rows under a "+" code and the 8 plywood rows with their
pack/loose break intact all still pass unchanged.

### Ask Hurford's
1. **Does the broken pack fee apply to the plywood list too?** The rule sits on the supplier, so it is
   costing every Hurford's order including plywood. Damien confirmed it for the flooring list only.
2. What a full pallet is per product, since the workbook prints the column blank and it is now the
   threshold for $80.
3. The lamella on the 4 First Floors 13.5mm rows, and lead times generally.

---

## 27 Sep 2026 — HURFORD'S 2.21% FUEL SURCHARGE, FROM 23 SEP, ON EVERYTHING

Damien: "Effective 23.09.2026 there will be an added 2.21% fuel surcharge to all orders plywood to my
warehouse is free". Asked whether that meant the flooring, the plywood or every Hurford's order, he
said: "All orders including solid, plywood and engineered".

So it is supplier-wide, not per list. Seeded once against the Hurford's supplier row as a second fee
rule: `kind: "fuel"`, `basis: "percent_of_order"`, `percent: 2.21`, `amount: null`, `autoApply: true`,
`effectiveFrom: "2026-09-23"`, no end date. Same shape as Tarkett's 2.1%, which was the first
percent-based fee in the book.

### It stacks with the $80 and does not compound on it
`percent_of_order` reads off the GOODS ex GST only, never the order total, so the $80 broken pack fee is
not itself surcharged. The two rules are different kinds on different bases and they sum independently:
the fuel lands in `surchargesExGst`, the $80 in `packingExGst`, and `freightExGst` stays $0 because
Hurford's still deliver to Nerang for nothing. A short order carries both. One box of Australian Native
Blackbutt is $162.33 of goods, $3.59 of fuel, $80.00 broken pack, $245.92 ex GST.

The two charges pull in opposite directions with order size. On that one box the $80 is 32.5% of the
total and the fuel is 1.5%. On a 400 m2 order at $34,000 of goods the $80 is 0.23% and the fuel is
$751.40. The flat fee punishes small orders, the surcharge scales with big ones.

### It is in no price, on purpose
2.21% is not folded into any of the 178 seeded rates, the same call as Tarkett's. The day Hurford's drop
it, one fee row comes off instead of two price lists being re-imported. Worth $1.24/m2 at the cheapest
flooring rate of $56.00, $2.54 at the dearest of $115.00, $1.94 on First Floors Blackbutt 135mm at
$88.00, and $1.01 a sheet on 17mm plywood at the $45.62 pack rate.

The legacy `fuelSurchargeActive` / `fuelSurchargePct` columns on the supplier are set true and 2.21 in
step with the rule. They are display only, no money goes through them, but leaving them off would have
the supplier card reading "no surcharge" over a live rule.

### Backdated by four days
Stated on the 23rd, seeded on the 27th. Any Hurford's order placed on or after the 23rd owes it,
including one quoted before that date, so anything quoted in the week either side is worth re-checking.

### "Solid" has no list behind it
Damien's answer names three lines, solid, plywood and engineered. Only two are on file: the plywood and
the engineered flooring. Hurford's do sell solid timber flooring and that is plainly what he meant, but
nothing is seeded to price it. The surcharge does not care, it sits on the supplier and prices whatever
is on the order, so this is not a blocker. It is an open request, flagged on the supplier row.

### Also confirmed
Free delivery now covers the plywood explicitly, not just the flooring. That closes half of the open
question from the last entry. Every plywood row's note now says delivery is free with no minimum and
carries the 2.21% as what the rate excludes.

### Verified
`check-hurfords-timber.ts` passes in full, **233 checks**, up from 200. New section 2b proves the rule
is live today and was not live on the 22nd, that it bills 2.21% of goods and not of goods plus the $80,
that a short order carries exactly two charges, that striking the $80 off an all-full-pallet order
leaves the fuel behind and nothing else, and that a full pack of 17mm plywood picks up $32.26 of fuel
off the same rule. Lint clean, 0 warnings and 0 errors.

### Still to ask Hurford's
1. **Does the broken pack fee apply to the plywood list too?** Still open. Damien answered the delivery
   half of this, not the fee half, so the $80 is currently costing every Hurford's order including
   plywood on the flooring list's wording alone.
2. **Is there a solid timber list?** Named in his own answer, not in the book.
3. Whether the 2.21% has an end date, and what a full pallet is per product.
