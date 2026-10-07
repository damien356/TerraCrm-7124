# Terra Ops: project notes

Last updated: 8 Oct 2026 Brisbane. Checked against the code, GitHub `main` (`8878174` and the notes commit after it), the live site and the live database.
This file replaces `STATE.md` as the source of truth. `STATE.md` (29 Sep) is out of date.

Status words used below:
- **Live**: built and running on ops.terraflooring.com.au.
- **Pushed, not published**: on GitHub `main` and its database change applied on live, but the site still runs the older version until Damien publishes. (Everything up to `8878174` was published 8 Oct, so those items are now Live.)
- **Built, not live**: code written in the sandbox, not pushed, its database change not applied.
- **Started**: part written, paused.
- **Not built**: nothing in the code yet.

---

## 1. Access levels (Live)

Three roles. Old `installer` values count as Field.

| Role | Can do | Never sees |
|---|---|---|
| Admin | Everything. Price book, costs, markups, settings, logins, finance, payables, purchasing, the email inbox, backups, deleting records. | |
| Office | Jobs, quotes, contacts, companies, schedule, offers, messages, memos, referrers, the quote agent, installer invoice status, SWMS on or off and the SDS sheets. | Price book, costs, markups, installer rates, bank details, credit limits, settings, logins, finance, payables, the email inbox. |
| Field (Crew) | Their own tasks, offers, pay, SWMS and invoices. Only the job people the office ticked Show to Crew, chosen job by job. Any tag can be shown, Supervisor included. | Customer prices, quotes, invoices, margins, cost, referral figures, the billing company, anyone else's rate. |

- An Office login can be given a "see costs" switch by Admin. It then shows cost and markup on quotes and supervisor gross profit. It can never change a cost.
- The quote agent ignores that switch. Only Admin gets cost through the agent.
- Cost stripping happens on the server, not just hidden on screen.
- **Office leaks:** fixed and live, published 7 Oct (section 13). `lib/staff-view.ts` strips bank details, credit limit and the labour rate breakdown for anyone but Admin.

## 2. Quotes and bundles (Live)

- A quote can show the client one combined bundle (default) or split by floor type plus extras.
- The client PDF shows bundle totals only. No line, quantity, rate or cost leaves the server for the client.
- Every rate book line added to a quote is tagged Labour. Products are Material.
- Office has a discount limit. Minus lines, typed prices and status changes cannot get around it.
- Accepted quotes are locked. Changes need a new version.
- Quote number plus version is unique.

## 3. Quote agent (Live)

- In the quote builder. Typed or spoken requests become proposed lines and wording.
- Staff tick what they want and press Apply. It never changes a quote on its own.
- It runs a pre-send check on the quote.
- Admin and Office can use it. Field cannot.
- Office never sees cost or markup through it, and never sees an Admin's conversation on a quote (Admin messages can mention cost).
- History is kept per quote.

## 4. Floor sanding price list (Live)

The rate book Timber section has 24 lines, all "work" items, so all go on quotes as Labour. The sanding lines:

- Floor sanding, per m2
- Coating, per coat, per m2
- Stairs, water-based: standard step, winder step, wraparound step, landing 1m x 1m, landing 2m x 1.2m
- Stairs, stained: the same five

**To confirm with Damien:** is anything missing from his sanding list (for example edging, filling, stain per m2, extra coats)?

## 5. Deposits (Live)

Current rule (Damien, 6 Oct):
1. A company on the quote wins. Its own % if set, otherwise 0% for a builder, 50% for any other company.
2. No company: the contact's own %, otherwise 50%.
- This only prefills a new quote. The % stays editable.
- The cashflow forecast also assumes 50% for residential work.
- No deposit cap check. Damien, 7 Oct: ignore the QLD caps. Do not build one.

## 6. Job contacts and roles (Live, published 7 Oct)

- Roles belong to the job, not the person. One card can be Owner on one job and Property manager on the next.
- Tags: Owner, Tenant, Supervisor, Property manager / Real estate agent, Builder contact, Accounts, Other. A person can hold several on one job.
- Ticks per person: Show to Crew, Site access, Decision-maker, gets SMS, gets email, plus a "when to contact" note. Ticking Site access also ticks Show to Crew.
- Each person stores the company they acted for when added, so referral credit stays with that company if they move.
- Quotes carry the same people list. It copies to the job on accept or convert, and to new versions.
- A supervisor is optional, even on a company job or quote. Not every company has supervisors. When one is picked they must belong to that company. The supervisor comes from the supervisor picker, not a free tag.
- Crew see only people ticked Show to Crew on that job: name, number, their tags on the job, the Site access and Decision-maker ticks and the note. Never prices, cost, referral figures or the billing company.
- New job defaults: the owner on a private job and any tenant start ticked Show to Crew. A builder contact or supervisor is ticked by hand.
- On day one the SQL ticks Show to Crew for everyone who was ticked Site access or Decision-maker and is not a supervisor, plus every tenant, so Crew sees the same people as before.
- Old ServiceM8 jobs have nobody tagged. The job page asks staff to tag people.
- Also in this batch: duplicate contact finder and merge, company types page.
- Database change: `sql/2026-10-07-job-contacts.sql`. Applied on live 7 Oct after backup `backups/terra-live-pre-jc-callbacks-2026-10-07.db`.

## 7. Referral tracking (Live, published 7 Oct)

- Only people tagged Supervisor or Property manager / Real estate agent count as referrers.
- Shown by person and by company (the company they acted for).
- Quoted value: the latest sent version of each quote they are on. Invoiced value: Terra Ops invoices on their jobs, not drafts or voids. Both ex GST.
- Starts clean. Nothing is guessed from ServiceM8.
- Sales figures only. Office can see it.
- Shipped with job contacts (section 6), commit `62a646c`.

## 8. SWMS (Stage 1 live 7 Oct. Stage 2 live, published 8 Oct)

Plans: `/home/user/plans/swms/editor-brief.md` and `/home/user/plans/swms/library.md` (Damien's 7 Oct attachments).

**Already live before Stage 1:** the server side. Crew `forTask` and `sign`, the 412 "SWMS needed" gate on start and finish, the hazard library in `lib/swms-library.ts`, the signed PDF, and the web page `/safety` (SWMS and SDS). On live, 0 jobs, contacts or companies have SWMS turned on, 0 signed records, 0 SDS uploaded.

**Damien's decisions, 7 Oct:**
- Crew SWMS screen comes before finishing callbacks. App only, not the Crew web page.
- Four stages, all approved:
  1. Crew SWMS screen in the app, using the current built-in content as version 1. Ships as an OTA.
  2. Templates move into the database, plus a Settings, SWMS editor: task blocks, templates, site checks, SDS upload with expiry, draft then publish with versions, preview, change log. The 9 library templates load as drafts.
  3. PDF branding, footer, Reviewed-by and GPS, site-check alerts, emailing the PDF to the builder, re-sign when a new version is published mid-job.
  4. Offline signing. Needs native storage, so it goes in the next store build with the scanner.
- SWMS is picked automatically from the labour on the job. The installer can change it if it is wrong.
- Site check "No" or "Unsure" turns the job card red and emails team@ (Stage 3).
- Products by work type: tackifier for carpet tiles only, timber adhesive for timber only, primer and leveller only when levelling, solvent coating when sanding and coating.
- Waterproofing and light trades (skirting, doors, silicone, furniture, nosings, measure and quote) need no trade section. They get the 8 every-job hazards only.
- Office and Admin can both turn SWMS on and manage SDS sheets.
- **Review:** Admin looks over the content, quickly. No WHS consultant. Damien: it is there to satisfy the insurance builders, do not spend time on it. (The library draft says a WHS consultant should review it. Damien has overruled that.)

**Stage 1, built 7 Oct:**
- App: `app/task/swms/[id].tsx` (the screen), `components/signature-pad.tsx` (finger signature, no native library, OTA safe), `queries/swms.ts`. The task screen shows "SWMS needed today" or "SWMS signed for today", and the start button reads "Sign SWMS and start" when one is due.
- Flow: everything pre-ticked from the labour, "Same work as last time?", "Wrong work type? Change it", optional site note, "I have read" tick, name, signature, sign and start.
- Server: two new sections, `removal` (with the asbestos stop-work line) and `sanding_coating` (from library SWMS 09), plus their skill rules. All SWMS office procedures moved from Admin only to Admin or Office.
- Tested on a scratch copy only: gate, sign, PDF, start, Office access, Field blocked, every live skill mapped.
- **Published 7 Oct** by Damien: website (`c99a690`) and the OTA to build 7 (1.0.2). Not yet tried on a phone.
- **Phone test:** use job #4446 "DEMO job for installer app" (its only task is already complete, so it needs a new task for today). The stored demo.installer@ password no longer signs in on live.
- Stages 2 and 3 come after callbacks (Damien, 7 Oct). Stage 4 waits for the next store build.

### SWMS Stage 2 (Live, published 8 Oct. `8878174`)

Plan: `/home/user/plans/swms/stage2-plan.md` (approved). Code is on `main` as commit `8878174`.

- **Database:** SQL file `packages/web/src/api/database/sql/2026-10-07-swms-stage2.sql`. Additive only: `safety_docs.review_on` plus 7 new tables (`sds_products`, `swms_blocks`, `swms_templates`, `swms_template_versions`, `swms_site_checks`, `swms_changes`, `job_swms_templates`). Applied to live 8 Oct with Damien's OK. Live now has 96 tables. No existing row changed. Seed result on live: 10 published, 9 drafts, 19 blocks, 7 site checks, 8 SDS products.
- **Seed** (`lib/swms-seed.ts`): today's built-in content becomes 10 published templates at version 1, so crew sees no change. The 9 library templates load as drafts. 19 blocks, 7 site checks, 8 SDS products. Runs once.
- **Crew side:** `forTask` and `sign` now read the published library (falls back to the built-in content while the tables are missing). Same response shape, no app change. Signed SWMS keep the version they were signed on.
- **Replace rule (default given to Damien):** publishing a library template takes the matching words from the built-in one it covers. The old one is archived, never deleted, once it has no words left. Laminate and Hybrid both replace built-in `hybrid`.
- **Web page `/swms-library`** (Office and Admin, under Schedule): Templates (warnings, live, drafts, archived, editor with drag order, publish with what changed and reviewed by, crew preview and sample PDF, version history), Task blocks (hazards, risk before and after, SDS), Site checks, SDS products, Change log.
- **`/safety` SDS library:** "Review by" date on upload (defaults to issue plus 5 years). Expired sheets show red.
- **Job card:** SWMS card lists the sections crew signs, and Office can add or remove one per job.
- **PDF:** risk line under each hazard, PPE line under each section.
- **Checked 8 Oct:** lint, build, api tsc 0, app tsc 172 (baseline), mobile tsc 0. Scratch test 72 checks passed. Screens checked on a scratch copy as Office. Dry run on a copy of the live backup `terra-live-pre-swms-stage2-2026-10-08.db`: no existing row changed, library equals the built-in content.
- **Applied 8 Oct:** fresh backup first, `terra-live-pre-swms-stage2-apply-2026-10-08.db` (89 tables, 14,209 rows, integrity ok). Then the script `terra-scratch-tests/swms/s2-apply.tmp.ts`. The live site runs the older code, which does not read the new tables, so nothing changes for users until the code is pushed and published.
- **Published 8 Oct.** Checked on the live site: the SWMS library page is in the build and its server calls answer.
- **Next:** phone app check against the library. Stage 3 is below.

### SWMS Stage 3 (Applied to the database 8 Oct. Code pushed, not yet published)

Plan: `/home/user/plans/swms/stage3-plan.md` (approved and edited by Damien).

**Damien's decisions, 8 Oct:**
- A flagged answer on a site check marked "stops the job" means Crew cannot sign or start until Office or Admin clears the red card with a note.
- A flagged answer on any other check raises a red card and emails team@, but Crew can still sign.
- The builder gets an email only when Office presses "Email SWMS". Never automatic.
- GPS denied or timed out: Crew can still sign. The PDF says "Location not shared".
- Check 1 "Site induction done, or signed in with the builder" now stops the job.

**What was built:**
- **Database:** `sql/2026-10-08-swms-stage3.sql`. Additive only: new tables `swms_flags` and `swms_emails`, and 5 new columns on `swms_records` (site answers, GPS and related).
- **Server:** `lib/swms-checks.ts` (answer checks, red cards, team@ email, dedupe), `lib/swms.ts`, `routes/swms.ts`. Sign and start answer 412 while a stopping red card is open. Field cannot clear a card. Clearing needs a note of 3 or more characters. A cleared answer does not raise a new card for the same answer. Signs from older apps are stored as `not_sent` with no red card.
- **Re-sign:** when a new version is published mid-job, "Same as last time" is refused and the app shows what changed.
- **PDF** (`lib/swmsPdf.ts`): logo, SITE CHECKS with the answers, LOCATION (map link, "Location not shared" or "Older app, no location"), Reviewed by, footer with "Page X of Y".
- **Email SWMS:** Office picks the addresses on the job card. The PDF goes as an attachment from team@. Each send is logged in `swms_emails` and job history.
- **Web:** red cards on the job page (`components/swms-flags.tsx`), clear with a note. SWMS card shows site answers (flagged ones in rust), location, the email button, cleared cards and the email log. Site checks editor explains the "stops the job" setting.
- **App** (screen only, OTA-able): SITE CHECKS section filtered by the picked templates. A stopping answer shows a red "Do not start" card with "Check again", and Sign reads "Waiting for the office". Other flagged answers show a note. "What changed" banner. GPS through `expo-location` with a 10 second timeout and the last known location as fallback.
- **Checked 8 Oct:** lint 0, build ok, api tsc 0, app tsc 172 (baseline), mobile tsc 0. Scratch test 74 checks passed (`terra-scratch-tests/swms/s3.tmp.test.ts`). Phone flow tested on Expo web against a scratch server, and the office screens on the built site against a scratch copy. PDF checked by eye.
- **Backups:** `backups/terra-live-pre-swms-stage3-2026-10-08.db` and, just before the apply, `backups/terra-live-pre-swms-stage3-apply-2026-10-08.db` (96 tables, 14,283 rows, integrity ok).
- **Applied 8 Oct** with Damien's OK, by `terra-scratch-tests/swms/s3-apply.tmp.ts`: 9 of 9 statements ran, no existing row counts changed. Then `s3-block.tmp.ts` set check 1 to stop the job, logged as one change by Damien.
- Live still runs the Stage 2 code, so nothing changes for users until the code is published.
- **Publish order:** website first, then the OTA. Phones without the OTA still sign as before. They send no answers, so they raise no red card.
- **Next:** Damien publishes. Then check the job page and SWMS library on the live site, and mark this published. Phone test on job #4446 once David is on 1.0.2.

## 9. Callbacks (Live on the website, published 8 Oct)

Plan: `/home/user/plans/callbacks-plan.md`. Damien's decisions, 7 Oct:
- A callback is a normal job row linked to the original. It takes the next job number underneath but shows as `#3981-C1` everywhere. Search finds either.
- Cause and Chargeable are set by Admin or Office.
- Not chargeable: quotes and invoices are blocked on that job, and it is never revenue.
- Rework cost (labour, replacement product, return trip) is tracked and reported against the original installer. No charge to the installer. Admin only.
- Installer error: "pay the installer for this visit" is decided on each callback. No default.
- People copy from the original job with all their tags and ticks, Show to Crew included, so the supervisor carries over.
- Crew see it as a normal job. Never the cause, chargeable flag or rework cost.
- Photos: original install photos (read only), client photos in their own bucket, after-fix photos from Crew in Completion.
- **Texted no-login photo link: built with the email photo work (Damien, 7 Oct).**

Database: `jobs` callback columns and `callback_costs`, `sql/2026-10-07-callbacks.sql`, applied on live 7 Oct. No more SQL needed.

What is built:
- `lib/job-ref.ts`: `jobNumberSql` and `jobRef` give `4199-C1` for a callback and the plain number otherwise. Used in lists, PDFs, crew brief, field, purchasing, payables and installer invoices.
- `lib/callbacks.ts` and `routes/callbacks.ts`. Staff: options, create, chain, original, set cause, set chargeable. Admin only: costs, add cost, remove cost, report.
- A callback made from a callback still hangs off the original (C2, C3).
- Pay rule: installer error with "No, fix it at their cost" sets the visit pay to $0. Changing the cause asks again.
- `assertBillable` blocks quote create, update, send, accept and revise, and voice quotes, on a not chargeable callback. Marking a callback not chargeable is refused while a quote is sent or accepted.
- Supervisor counts leave out free callbacks. Referrer counts leave out all callbacks.
- Rework cost writes nothing to job history, because Office reads the history.
- Web: "Create callback" on the job page (pay choice required for installer error), banner with cause and chargeable, callbacks list on the original, original job card (products, notes, photos), rework cost card for Admin, Client photos bucket in the job file. Report at `/finance/callbacks`, Admin only.
- App (screen only, OTA-able): job shows `#4199-C1`, materials marked "Laid on the original job", Client photos and Original job chips, both read only. Crew sees no cause, chargeable flag or cost.
- Inbox finding: "file to callback" from the inbox cannot work. `message_attachments` is never written, so inbound attachments are not stored. Office uploads client photos into Client photos on the callback instead.
- Scratch tests: `/home/user/terra-scratch-tests/callbacks/`.
- **Committed and pushed 7 Oct as `d788d17`.** Website published 8 Oct with SWMS Stage 2 (checked on the live site). The app screen changes reach phones by OTA, which Damien publishes himself.

**Client photos from email (Damien, 7 Oct). Build after SWMS Stages 2 and 3:**
- Idea 1 only: the email agent collects photos from emails sent by anyone on a contact or company card. Saved once, linked to the person, and to the job when the thread or address matches. Skip logos and signature images.
- Mailboxes: team@ and damien@. Not billing@.
- First run looks back 90 days.
- Build the texted no-login photo link in the same piece of work. It is no longer deferred.
- Not chosen for now: photo picker in Create callback, search, unmatched tray, forward to team+4199@, MMS. Offer them again once idea 1 is live.

## 10. Payments

| Part | Status |
|---|---|
| Xero | Not built. No Xero keys in the env. See the Xero decisions below. |
| Stripe | Not built. Only an empty `stripe_payment_intent_id` column. No Stripe keys in the env. Account on file: `acct_1ALbPXLQOLdW3BHy`. |
| Cash and bank transfer from clients | Not built. There is no screen to raise a client invoice or record a payment. The `invoices` table is empty. |
| Supplier bills (payables) | Live, Admin only. Statement matching and mark paid. |
| Installer invoices | Live. Crew submit from their pay breakdown. Office moves them through Approved, Scheduled, Paid. Office can download the PDF. |

**Xero decisions**
- **Direction: two-way.** Damien, 6 Oct form: "Yes, read payment status and bank balance". Ops pushes invoices (staged and part-paid included) and reads back payment status and the reconciled bank balance. This replaces the earlier one-way (push only) rule.
- **Which Xero app:** Damien, 6 Oct: "i think we will make this inside the crm". The earlier plan was to reuse Terra Stock's Xero app. Not yet clear whether Ops gets its own Xero app or reuses Terra Stock's from inside Ops. Asked 7 Oct, waiting for his answer.
- Sales account 204 (same as Terra Stock). Planned callback: `https://ops.terraflooring.com.au/api/xero/oauth/callback`.
- **Build timing:** after client invoices.

## 11. Email agent (Live, read only)

- Three Google Workspace mailboxes connected: team@, damien@, billing@.
- team@ is the only one allowed to send. The other two are read only.
- Google OAuth app is set to Internal (Terra's Workspace only). Its client ID and secret are set.
- Admin only today. Office cannot open the inbox.
- None of the three shows a completed sync yet (`last_checked_at` is empty). To check.

## 12. Not built, possibly specced in another chat

Nothing for these exists in the code. Damien to paste or re-state the spec.
- **Product arrived:** red/green status, photo, the "client supplies product" toggle.
- **Delivery locations:** saved locations, "On site / Other address", the one-time site photo link.
- **Any no-login link** (quote signing, site photos, client photos). Ops has no public pages at all yet.
- Only related field today: `products.lead_time_days`.

## 13. Known problems (7 Oct review)

1. **Office leaks, server side. Fixed and live (`62a646c`, published 7 Oct).**
   - Job page, task page, schedule board, offers and declines: installer cards lose bank details and credit limit, tasks lose the labour rate breakdown, for anyone but Admin. Helper: `lib/staff-view.ts`.
   - Kept for Office (Damien, 7 Oct): per-task installer pay (`payAmount`) and the labour total (`labourCost`), which is the same pay figure.
   - Installer invoice PDFs stay open to Office, bank details included (Damien, 7 Oct).
   - Supplier detail sends Office no supplier charges, and the page hides that card.
   - Still open: `trustedOrigins` in `api/auth.ts` accepts any origin.
2. **Publish order.** Resolved 7 Oct: the job contacts and callbacks SQL is on live, so publishing current code is safe. Rule stays: SQL first, then publish.
3. **Callbacks and supervisor and referrer counts.** Fixed 7 Oct. Supervisors leave out free callbacks, referrers leave out all callbacks.
4. **Two supervisor sources.** Quotes keep `supervisor_contact_id`; jobs keep a Supervisor tag. The job contacts code syncs them on convert. Keep it that way.
5. **Company card roles and job tags differ.** Company cards use owner, manager, supervisor, accounts, property manager, purchasing, other. Job tags use the list in section 6. Fine, but do not mix them.

## 14. Open items

- **Android 1.0.1 "Couldn't reach the server":** checked build 6 itself. It does point at the live site, so the preview URL theory was wrong. The live sign-in endpoint works from here. Cause still unknown (phone network, Cloudflare, or something on the device). 1.0.2 shows the real error on the sign-in screen. Build 6 cannot take an over-the-air update, so 1.0.2 needs a new build.
- **Android 1.0.2 build:** built 7 Oct as EAS build 7 (1.0.2, store .aab, no camera scanner). Expo does not submit to Play on its own (no Android submit config in `eas.json`), so Damien downloaded the .aab and uploaded it to Play Console Internal testing himself. Next: David updates and tries signing in. If it fails, the sign-in screen now shows the real error. Version 1.0.2 in `app.json` stays out of git.
- **Camera scanner:** not in 1.0.2. Damien chose: scanner comes in a later store build, after the stock work.
- **Publish:** `62a646c` published 7 Oct. Checked the live bundle: Show to Crew, Duplicate cards and Referrers are in it. Damien to eyeball one job page's contacts.
- **Transfer pack:** Damien sent the review prompt for `content.md` (section 13) and Specs 2 to 6 from the other chat, but the ZIP did not arrive. Waiting for it. Spec 1 not found here yet. No comparison done, nothing built for it.
- **Texted no-login photo link (callbacks):** Damien chose 7 Oct to build it with the email photo work, after SWMS Stages 2 and 3.
- **Stripe:** keys not given yet.
- **Xero:** keys not given yet.
- **Google client ID and secret:** set for the mailboxes. No separate Google sign-in keys.
- **Slice 6 signatures:** waiting on the solicitor's T&Cs.
- **Insurer supervisor:** decided 7 Oct. Optional everywhere, insurers included. No warning.
- **David's card:** login David Walker is linked to installer card 9 "Dave Kohn" (test name, mobile 0412 000 333). Needs his real name and number. Damien skipped this on 7 Oct.
- **Test logins on live:** demo.installer@ (profile 15, card 1), qa.board@terra.local (Office), admin.test@terraflooring.local (Office). google-review@ is the Play Store reviewer login, keep until approval.

## 15. Work order (Damien, 7 Oct)

1. Finish callbacks. Done 7 Oct (`d788d17`).
2. SWMS Stages 2 and 3. Stage 2 live 8 Oct. Stage 3 next.
2b. Client photos from email, plus the texted photo link.
3. Client invoices, then Stripe and Xero.
4. Product arrived and delivery (spec needed).
5. Stock WIP.
6. Signatures, after the T&Cs.
7. Cleanup.

SWMS Stage 4 (offline signing) and the camera scanner go in the next store build.

## 16. Rules for working on Terra Ops

- Never run `db:push` or `db:migrate`. Database changes are SQL files applied by script: full backup, dry run on a copy, Damien's OK, then apply.
- Never push to GitHub without Damien's OK.
- Never print or commit secrets.
- No EAS builds in the sandbox. Builds start from the mobile publish dashboard.
- Checks before a push: lint, web build, both type checks.
- Every database change so far: backup in `/home/user/backups/`, latest `terra-live-pre-swms-stage2-apply-2026-10-08.db` (89 tables, 14,209 rows, integrity ok). Taken just before SWMS Stage 2 was applied on 8 Oct.

---

## 17. Archive locations (8 Oct)

Sandbox cleanup on 8 Oct. Everything worth keeping was archived first. Each place was checked.

**GitHub**
- Branch `archive/swms-stage2-wip` (commit `e501d1f`) held the 21 SWMS Stage 2 files during cleanup. Stage 2 was pushed to `main` as `8878174` on 8 Oct and the branch was deleted with Damien's OK.

**Supabase** (project `yozjpzkcbbvhjdyygetf`, bucket `terra-backup`)
- Database snapshot: `database/2026-10-07/193943256-utc.sqlite.gz` (89 tables, 14,146 rows).
- Postgres copy: schema `terra_backup`, 89 tables.
- Sandbox files: manifest `sandbox/manifests/2026-10-07T19-44-29.458Z.json`, also `sandbox/latest.json`. Files are under `sandbox/objects/<sha256>.gz`. 1,629 files, 0 failed.
- Media: 30 files, 0 failed.
- Verify run on 8 Oct: 226 checks passed, 0 failed.
- SDK 54 rollback: `sandbox/sdk54-rollback/2026-10-05T03-13-16-817Z.tar.zst`. The local folder was deleted on 5 Oct. This is the only copy. Do not delete it.
- `sandbox/latest-incomplete.json` is from a first run that stopped on 3 unreadable files. Leave it.
- The backup runs every 6 hours (schedule, Brisbane time).

**Sandbox only**
- Live backups before SWMS Stage 2: `/home/user/backups/terra-live-pre-swms-stage2-2026-10-08.db` (dry-run source) and `terra-live-pre-swms-stage2-apply-2026-10-08.db` (taken just before applying).
- Test screenshots, PDFs and small scripts from 5 to 7 Oct: `/home/user/terra-scratch-tests/evidence/2026-10-07/`.
- `terra-release/check-b6/b6.aab` (83 MB) is local only. The backup tool skips `.aab` files. Build 7 lives in EAS.

