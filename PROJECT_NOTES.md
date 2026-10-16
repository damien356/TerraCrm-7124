# Terra Ops: project notes

Last updated: 9 Oct 2026 Brisbane (section 18 added, master spec Step 1). Checked against the code, GitHub `main` (`8878174` and the notes commit after it), the live site and the live database.
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
- **No QBCC deposit cap, ever.** Damien, 7 Oct: ignore the QLD caps. Damien, 9 Oct, again: "forget the QBCC, don't ask again". No cap, no warning, no off-site tick. Spec 0.1 and the "legal cap" on the section 2 deposit invoice are dropped. The deposit invoice uses the quote's own %. Do not raise QBCC caps with Damien again.

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
- **Published 7 Oct** by Damien: website (`c99a690`). The OTA did not land: checked 8 Oct, the Expo production branch has no updates at all. See Stage 3 below.
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

### SWMS Stage 3 (Website live 8 Oct, `f9f2fc0`. App OTA not yet on phones)

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
- **Website published 8 Oct** (second try, the first publish left Stage 2 up). Checked on the live site: the new bundle has Email SWMS, Location not shared and the red card text, and `swms/flags`, `clearFlag`, `emailRecord`, `reportCheck` answer 401 (they exist).
- **OTA problem found 8 Oct:** the Expo production branch (project `b38734e2`) has never had an update. So no OTA has reached phones, Stage 1 included. Build 7 was built 7 Oct 10:37 UTC, before Stage 1 (`c99a690`, 13:06 UTC), so it has no SWMS screen. A phone on build 7 gets "SWMS needed" from the server on a SWMS job and has nowhere to sign. David hit this on 8 Oct.
- **Fingerprint:** build 7 runtime is `6e69f4a5d02030fc4d9b24d5ff6a1a142bb995b0`. The sandbox gives `3e45523a...`. The only difference is `extra.apiUrl`: build 7 has `https://ops.terraflooring.com.au`, the sandbox has the preview address. An OTA only reaches build 7 if it is published with the live address. After any OTA publish, check `eas update:list --branch production` shows runtime `6e69f4a5...`.
- **The app publish button is a store build, not an OTA.** Damien pressed publish on the mobile preview 8 Oct. It started EAS build 8 (`58590612`, Android, 1.0.2, production profile) at 04:46 UTC, and still no update on any branch. So app changes reach phones only through a store build, uploaded to Play by Damien. Build 8 has SWMS Stages 1 to 3. The production profile sets `EXPO_PUBLIC_API_URL` to the live site.
- **Next:** build 8 finishes, Damien uploads the .aab to Play Internal testing, David updates. Then the phone test on #4446.
- Live jobs with SWMS on (8 Oct): #4159 (id 3937, task 40, David, 5 Oct) and #4446 (id 4224, task 41, David, 10 Oct).

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


---

## 18. Master spec (Damien, 9 Oct) and Step 1 impact check

Status: **Step 1 review done 9 Oct. Section 0 published 9 Oct (website, `57d85e0`). diag v6, every timer on. See 18.4.** Full impact check: `/home/user/terra-impact-check.report/content.md` (sandbox). Original spec: `/home/user/Attachments/terra-master-spec_ZFI9E9.md`.

Standing rule from the spec: before building anything, list what it touches, what it conflicts with, any data to migrate and whether it needs a new phone build. Wait for the go-ahead. Update this file when done.

### 18.1 The spec (decisions are final)

Build order: 0 safety fixes, 1 numbering, 2 send quote and online accept and deposit, 3 measure bookings, 4 tasks by trade and stars and assignment, 5 Pedro hourly savings, 6 follow-up journeys, 7 repairs.

**0. Safety fixes**
1. Deposit follows the Qld caps by quote total: up to $3,300 max 20%. $3,301 to $19,999 max 10%. $20,000 or more max 5% (20% if off-site work is over 50%). Builders 0%. Warn when over. Needed before quotes are sent from Terra.
2. Accept race: only one installer can win. Losers see "already taken".
3. Job number race: two jobs can never get the same number.
4. Lapsed 2-hour holds settle on a timer. Office is told when a hold locks.
5. Sign-in origins locked to ops.terraflooring.com.au and the app.
6. Enforce "installer can see customer name and phone" or remove the false "Enforced on the server" text.
7. Make Offer expiry hours and GST rate work or remove them. Remove Business name and Broadcast shows pay if unused.
8. Hide Suppliers owed from Office.
9. Journeys and server backup timers run on live.
10. Auto statuses: quote accepted to Won, all tasks booked to Scheduled, first task started to In Progress, all tasks complete to Complete. Manual change still allowed.
11. Push: test device registration on the next phone build with the new tester.
12. Damo (floorsbyyou email) replaces David as tester, on his own installer card. Damien adds him to Play Internal testing.
13. Publish once 0.1 to 0.10 are checked.

**1. Numbering**
- Old job numbers (218 to 4447) and ServiceM8 refs stay. New jobs start at 188000, start number set by Admin in Settings.
- Job 188000. Quote Q188000, revisions Q188000-2, -3. Variations after acceptance are a new quote version with their own invoice.
- Client invoices IQ188000-1 deposit, -2 final, -3 and up for stages. Tasks 188000-A, -B. Repairs R188000-1 (replaces -C1, old ones stay searchable). POs PO188000-1 (old POs keep their numbers).
- Gaps are fine. Enquiries get a job number straight away. Xero must use Terra's invoice number.

**2. Send quote, online accept, deposit** (needs 0.1 and the solicitor's T&Cs)
- Email from team@ via Resend, sender "Damien from Terra", replies to team@. PDF plus a no-login link. Auto Sent and job to Quoted.
- Client reads T&Cs, signs, pays the deposit by card (Stripe, webhook marks paid) or sees bank details (marked once reconciled).
- On accept: lock the quote, set job value, job to Won, deposit invoice IQ-1 at the quote deposit % (no legal cap, see section 5), send the material selection form to the decision-maker, office task "order product".
- Track link views. Push Damien at 3+ views. Fix message attachments so the PDF is saved on the conversation.

**3. Measure bookings**
- Sales measure by Damien or Office: on the Schedule as a measure, Office bookable, default 1 hour plus travel, free, one-way push to Damien's Google Calendar, SMS confirm and day-before reminder. Phone Office tab "Start measure" opens voice quote linked to the client and job, plus photos and room and m² entry.
- Site capture by Pedro (Crew) for insurance and builder jobs: new skill "Site measure", task at Lead stage, pay $0, blue strip and tape-measure look, address and Navigate, access and key, who to call. Checklist with a camera per line: each room with m², photo each room, doorways, subfloor, key location, voice note. "Finish measure and send to office" attaches everything and pushes "ready to quote".
- New statuses Measure booked (after Lead) and Measured.
- New enquiry screen: contact, new site address with autocomplete, lead source (required), job type, duplicate check on phone and email, "Book measure". Typing a new address works on contact, job and booking.

**4. Tasks by trade, Crew view, stars, assignment**
- Two or more trades on a quote split into one task per trade (188000-A carpet, -B vinyl). Office can merge.
- Hard floors before carpet. Carpet shows "Waiting on hard floor", installer pushed when done. Override per job. Trims default to the hard-floor installer, shown on both. Timber multi-day stages with "stay off floor until" notes. Photos, sign-off and pay per task.
- Crew room list from `job_areas`, grouped by flooring type, plain words, no prices. Read aloud button, optionally on "On my way". Each installer sees only his task plus who else is on site and when.
- Stars per skill replace the single star. Untick = never offered. 4 to 5 stars get the first hour, then everyone with the skill for the rest of the 2 hours. 4 to 5 stars lock instantly, others hold. Nobody accepts: push Office. Sub-skills for vinyl, timber, carpet and hybrid. Installers never see stars.
- Manual assignment always overrides: assign whole job, warn (not block) on missing skill or low stars with an optional reason, per-task "photos each stage" and "Office check", helper with pay per person, temporary star change with an end date, unassign, reassign, swap with pushes, direct assigns need the installer to tap Accept, override log.

**5. Pedro hourly savings**
- Pedro's skills are Hourly at $47 (Admin only). Quotes always price labour at the per-m² contractor rate.
- On an install task Terra suggests a fixed task pay = estimated hours x $47. Office can adjust. Paid the fixed amount however long it takes.
- Pedro sees only the room list and his fixed pay. Never hours, per-m² rates, client price or saving.
- Per task, Admin only: benchmark cost, actual pay, on-costs (default $50 a day, set on his card), gross saving, true saving. Admin report by job, month, year, installer. Pedro can get prep tasks linked to a main task. Site measures unpaid.

**6. Follow-up sequence** (existing journeys engine, sender "Damien from Terra")
- Day 0 quote email with About Terra block. Day 1 product email from the stored blurb. Day 3 SMS. Day 7 what happens next. Day 14 call task for Damien. Day 25 expiry reminder. Day 30 Expired plus requote link.
- Healthcare clients get the full sequence. Off by default for builder, insurance and property manager jobs, with a per-job toggle. Stops on reply, accept, decline or Pause. Unsubscribe and STOP on every message. Days, wording and on/off in Settings. One blurb per product, ChatGPT drafts, Damien approves. Decline needs a one-tap reason. Every message on the job timeline.

**7. Repairs** (extends callbacks)
- "Create repair" asks which task(s), with trade, installer and date, or "Not sure, inspect first". Inspections by Damien or Office, booked like a sales measure.
- Original installer pre-selected for the fix, Office can pick anyone. Cause and rework cost stay on the original installer. Fixer is paid. Several tasks can be ticked, at-fault installer or "Shared".
- Chargeable repairs: quote first, then book, using the R number. Callback report shows repair rate per installer per skill.

### 18.2 Impact check answers (short)

**A. State:** every section part-exists. Not started at all: no-login pages, Stripe, measure bookings, per-skill stars, savings, unsubscribe route.

**C. Main conflicts:**
- Spec says "database sequence". Live is libSQL, which has none. Plan: a one-row counter updated in one statement, and an "only if still free" update for accepts.
- All 7 live quotes have no job. Quotes must now be made on a job so they get Q plus the job number. Voice quote must make the job first.
- Accept today expires every other version and sets job value to one version's total. Variation versions need a rule (question to Damien). A `variations` table (0 rows) also exists.
- Convert makes one task per quote line. Spec wants one per trade (skills already have trade groups).
- `tasks.assign` blocks without the skill tick and skips Accept. Spec wants warn and Accept.
- Single `installers.star_rating` drives instant lock today. Plan: copy each installer's star onto each ticked skill.
- Two pay sources: offers use the old per-skill rate on `installer_skills`, labour cost and the rate card use `labour_rates`.
- Journeys are homeowner-only by design (two guards plus `lib/trade.ts`). Spec wants healthcare companies and per-job opt-in for builders. No healthcare, insurer or property manager company type exists.
- The unsubscribe link is built but `/api/unsubscribe/:token` has no route. Must exist before any journey email.
- ~~Card deposit % can exceed the QBCC cap.~~ Dropped: no QBCC cap (section 5).
- Once the server backup timer runs on live, it overlaps the sandbox 6-hourly schedule.

**D. Migration:** no existing job number changes. Live counts: 12 tasks, 7 quotes (drafts, no job), 0 invoices, 0 POs, 0 callbacks, 0 journeys, 160 skill ticks. No ServiceM8 ref in 188000 to 260000. Two new statuses are inserts, job status ids stay. Auto statuses forward only, no back-fill. Risk to the 4,225 jobs: low.

**E. Phone:** backend changes go out with a website publish. JavaScript-only app screens could go OTA (`expo-updates`, fingerprint runtime), but every app change so far has shipped as a store build. Read aloud (`expo-speech`) and the geofence need a store build.

**F. Crew visibility:** confirmed no client prices, quotes, job value, other installers' rates, margins or costs. Savings and on-costs not built. **Gap:** the Crew rate card (`labour.myRates`) falls back to Terra's standard rate where the installer has no own rate, and task cards send `durationHours` and `payBreakdown`. Fine for per-m² contractors. For hourly installers (Pedro) these must be hidden in section 5.

**G. Blocking questions sent 9 Oct:** which Pedro (card 8 Pedro Silva or card 11 Pedro Souza), QBCC caps for non-homeowners, the journeys homeowner-only guard and client types, the room list source, variation versions, Damo role and David's login. Defaults taken on the rest are listed in the impact check report.

### 18.3 Damien's answers (9 Oct)

1. Pedro: cards 8 "Pedro Silva" and 11 "Pedro Souza" are the same person. Merge them into one card. He is the hourly installer at $47.
2. ~~QBCC cap warning on every quote that is not for a builder.~~ Reversed later on 9 Oct: forget the QBCC, don't ask again. See section 5.
3. Follow-ups stay homeowner-only for now. No new company types, no per-job opt-in for builders, insurers or property managers. Healthcare follow-ups wait.
4. Rooms come from the measure (sales measure or site capture creates `job_areas`). Each quote line picks a room.
5. A variation after acceptance is a full replacement quote. Job value = the new total.
6. Damo's login role goes to Crew (`field`). David Walker's login (profile 22) is switched off. Data change: backup and dry run first.
7. Go-ahead given for section 0.

### 18.4 Section 0 build (9 Oct)

Checked: lint clean, web build, API tsc 0, app tsc 172 (baseline), mobile tsc 0. Scratch test `terra-scratch-tests/section0/t-s0.tmp.ts`: 59 pass. UI checked on a scratch vite.

- **0.1 Deposit cap:** built, then taken out the same day on Damien's word. Not shipped. See section 5.
- **0.2 Accept race:** `routes/offers.ts` `lockTask`. The offer is claimed only while pending or provisional, then the task only while unassigned or offered and not held by someone else. Both are one conditional update each. The loser's offer closes as filled and he sees "already accepted". Holds use the same rule. Withdraw also closes holds.
- **0.3 Job numbers:** `lib/job-number.ts` `nextJobNumber()`. One upsert on the `settings` row `job_number_last`. The next number is the higher of the counter and the top job number, plus 1. Used by new job, quote convert, callbacks and voice memo jobs. The ServiceM8 import still writes its own numbers, and the counter copes with that. Section 1 (start at 188000) changes the floor, see 18.5.
- **0.4 Hold timer:** `lib/offer-timer.ts`. Every 60 seconds on the live server: lapsed offers expire (task goes back to unassigned, office gets "Nobody took it") and lapsed holds lock (office gets "Hold confirmed"). `OFFER_TIMER=on|off` overrides.
- **0.5 Sign-in origins:** `api/auth.ts`. Live trusts only `WEBSITE_URL`, ops.terraflooring.com.au, terraop-l8jfdfu.runable.site and the app scheme `runable-terraop-l8jfdfu://`. Sandbox and preview servers still trust the asking origin, because their hostnames change. Tested: a foreign site gets 403 on live, the site and the phone app get 200.
- **0.6 and 0.7 Settings:** the Dispatch rules card and the false "What installers can see" card are gone. One fixed card, "Offers and what crew see", says how it really works. Your details keeps only Business phone. GST is fixed at 10%. The old settings rows stay in the database but nothing reads them, and they are hidden from "Anything else". Voice `call_contact` no longer reads `installer_can_see_customer_phone`.
- **0.8 Suppliers owed:** hidden from Office in the menu. Office opening the link gets "Admin only".
- **0.9 Timers on live:** journeys, server backup, mail agent, reminders and offers all use `isLiveServer()` in `lib/runtime.ts`. `diag` is version 6 and lists every timer under `timers`.
- **0.10 Auto statuses:** `lib/job-stage.ts`. Quote accepted → Won. Every live task booked (installer and date) → Scheduled. First task started → In Progress. Every live task complete → Complete. Forward only. Jobs on Invoiced, Paid, Cancelled or a custom status are never moved. No back-fill. Every move is logged as `status_changed`. Convert starts a job at Won if the quote was accepted, Quoted if it was sent.
- **0.11 Push test:** waits for the next phone build.
- **0.12 Logins:** done on live 9 Oct after a backup (`backups/terra-live-pre-logins-0-12-2026-10-09.db`) and a dry run. Profile 15 (Damo) role is `field`. Profile 22 (David Walker) is switched off. Card 9 "Dave Kohn" stays active (it has tasks booked 9 and 10 Oct).
- **0.13 Publish:** done 9 Oct, website only. Live `diag` is version 6 with every timer true. Sign-in from a foreign origin gets 403 on live.
- Live drafts 1005, 1006, 1007 stayed at 50%. All 7 test quotes (1001 to 1007) were deleted later on 9 Oct, see 18.5.

### 18.5 Section 1 build (9 Oct)

One number per job. The job, its quotes, tasks, repairs (callbacks) and POs all carry it. Client invoices (IQ) come with section 2.

Checked: lint clean, web build, API tsc 0, app tsc 172 (baseline), mobile tsc 0. Scratch test `terra-scratch-tests/section1/t-s1.tmp.ts`: 106 pass, 0 fail, on a copy of the pre-section1 backup. UI checked on a scratch vite (`section1/s1ui.py`).

- **Test quotes deleted on live (9 Oct):** quote ids 2 and 4 to 9 (numbers 1001 to 1007) and their 17 `quote_items`. `voice_quote_captures` 3, 6, 19 and 20 had `quote_id` set to null. Backup `backups/terra-live-pre-section1-quotes-2026-10-09.db`. Script `terra-scratch-tests/section1/s1-del-quotes.tmp.ts`. Live then had 0 quotes, 0 invoices, 0 POs, 0 callbacks, and jobs 218 to 4447.
- **Refs:** `api/lib/refs.ts` (pure, shared with web). Quote Q188000, then Q188000-2 for the next version. A quote on a repair is QR188000-1. Task 188000-A, 188000-B. Repair R188000-1. PO PO188000-1. Invoice IQ188000-1 (ready for section 2). Also `jobText`, `parseRepairRef` (reads old 3981-C1 too) and `parseQuoteRef`.
- **Job numbers:** `lib/job-number.ts`. The counter starts at 188000 (`job_number_start`, `job_number_last`). `setJobNumberStart()` refuses a start at or below the highest number used, or above 99,999,999. After publish the first new job on live is 188000.
- **Repairs:** a repair does not use up a run number. Its job row gets a hidden number `1e12 + parent*1000 + seq` (`repairJobNumber`, `REPAIR_NUMBER_BASE`), left out of the highest-used checks. It shows as R{parent}-{seq}. Search finds R refs and old C refs.
- **Quotes:** `lib/quote-number.ts` `quoteNumberFor`. A quote on a job takes the job's number, version max+1. A quote with no job takes the next job number, and convert keeps it. Moving a quote to a job with a different number is refused.
- **POs:** PO{main job}-{n}. A repair uses the parent's number. `poRefsIn` and `strictPoRefsIn` read new and old forms and ignore IQ, R and dates.
- **Booking line:** `lib/booking-command.ts` reads "188000-B", "r188000-1-a" and "3981-c1". `routes/tasks.ts` picks the task by letter. Unknown letter: "No open dispatch X-Z". No letter on a multi-task job: "Which one? Type it as 188000-A".
- **Task `ref` in payloads:** tasks board and get, booking command, field (via `taskRefSql` in `lib/job-ref.ts`), dashboard, costing (plus quote `ref`), installer invoices (`job.ref` and email text).
- **Settings:** Business rules tab has a "Job numbers" card (admin only) with a "Too low" warning. `settings.set` refuses the two job number keys.
- **Screens:** web job page, schedule, book installer, command box, voice memo, costing, dashboard, quotes list, quote builder (title, bank Reference, versions, convert), contact page, voice quotes. Quote PDF header, footer, title, bank Reference and file name ("Terra Flooring Quote Q188000.pdf").
- **Phone:** task page, Office, Me, Offers, task invoice and voice quote show refs. They fall back to the old form until the app update lands (OTA or next store build). Backend goes out with a website publish.

### 18.6 Section 2 build (9 Oct)

Send a quote, accept it online, take the deposit, then the material selection form.

Checked: lint clean, web build, API tsc 0, app tsc 172 (baseline), mobile tsc 0. Scratch test `terra-scratch-tests/section2/t-s2.tmp.ts`: 158 pass, 0 fail. UI checked on a scratch vite (`section2/s2ui.py`).

- **Live database (9 Oct):** backup `backups/terra-live-pre-section2-2026-10-09.db`, dry run on a copy, then `section2/apply-s2.tmp.ts` with Damien's OK. SQL `api/database/sql/2026-10-09-section2.sql`. The empty `invoices` table was rebuilt (`number` is now TEXT, IQ188000-1), plus 4 new tables: `quote_links`, `quote_signatures`, `material_selections`, `material_selection_items`. No columns added to quotes or jobs. FK check 43 rows before and after (old orphans).
- **Email quote:** `lib/quote-email.ts`, `routes/quoteSend.ts`. Goes from team@ through `sendAsTeam`, sender "Damien from Terra", replies to team@. The PDF is attached and logged as a `message_attachments` row only, never `job_media`. The link is added if the office takes it out. "Mark as sent" stays for quotes sent another way.
- **Client link:** `/q/:token`, no login (`lib/quote-links.ts`, `routes/publicPages.ts`, `pages/public-quote.tsx`). Drafts are hidden. Staff visits are not counted. Office gets one push on the first client view. No cost fields go out. A replaced version points to the newer one.
- **Online accept:** `lib/quote-accept.ts`. Needs full name, signature and the terms box (Supply Terms `lib/supplyTerms.ts`, version 2026-10-06). Stores the signature with IP and user agent and a signed PDF. Converts to the job with the quote's number, value and deposit. Raises the deposit invoice IQ{job}-1, creates the order task, sends the selection form and writes the cash event. 0% deposit raises no invoice. Bank transfer details show after accept (no Stripe keys yet).
- **Replacement after accept:** the old version becomes `replaced`. Job value becomes the new total. A variation invoice IQ{job}-n for the difference is raised only when the new total is higher. Replaced versions cannot be accepted or declined.
- **Client invoices:** `lib/client-invoices.ts`, `routes/clientInvoices.ts`, job page card `components/client-invoices.tsx`. Mark paid (Admin and Office): method, full or part, paid date (not in the future). Void is Admin only, needs a reason, and only before any payment. A paid deposit sets `depositPaid` and drops out of the forecast. Finance invoices list shows IQ refs.
- **Material selection:** `lib/material-selection.ts`, `/m/:token` (`pages/public-selection.tsx`). Per room: product, colour, notes. Goes to the ticked decision-maker, else the customer. Office can send again to another address. A superseded form is refused.
- **Deposit rule (Damien 9 Oct):** the accepted quote's deposit is the job's deposit. It only changes when the client accepts a new version. The job's Payment terms card shows it ("30% on quote Q188000-3") and its edit box will not change it. The forecast and job budget use it too, so a 0% quote forecasts no deposit instead of falling back to the card's 50% (`jobDeposit`, `acceptedQuoteDeposits` in `lib/cashflow.ts`). No live job had an accepted quote when this went in.
- **UI fixes found in testing:** the Email quote box is portalled out of the dark page header (its fields were white on white). The accept page clears "Tick the box" once fixed. Activity money reads $1,254.00.
- **Not done yet:** Stripe card deposit and webhook (waiting on keys), the solicitor's T&Cs, texted photo link (`plans/email-photos-plan.md` Stage 2).

### 18.7 New job screen, items 1 to 5 (10 Oct)

Make a job in one go: the contact, company, supervisor and site can each be picked from Ops or typed in new on the New job screen. No database change (uses the existing `company_contacts.job_title` column). No phone build needed.

Checked: lint clean, web build, API tsc 0, app tsc 172 (baseline), mobile tsc 0. Scratch test `terra-scratch-tests/items1-5/t-i15.tmp.ts`: 78 pass, 0 fail. UI checked on a scratch vite (`items1-5/i15ui.py`).

- **Damien's rules (final):** supervisor form has first name, last name, mobile, email, office phone, job title at the builder and notes. Only first name and mobile are required. Site is picked or typed, with Google address autocomplete. Lead source is required and has an "Unknown" option. New contacts and companies are checked by mobile, email or name, and the existing record is offered first. The supervisor can be skipped, and the job then shows "Supervisor missing". Anything made here is a normal full record.
- **API:** `lib/job-new-records.ts` (`checkNewRecords`, `createNewRecords`: company, then contacts with an activity line and the company link carrying the job title, then the site owned by the job contact and company). `jobs.create` takes `newContacts`, `newCompany`, `newSite`, the `contactKey` / `supervisorKey` / `billToContactKey` pointers, and `fileSupervisor` (files an existing card as supervisor under the picked or new company). A new company becomes the bill-to company. The bill-to person is added to the job as Accounts. A `records_created` activity line is logged. Any refusal writes nothing.
- **Lead source:** the `jobs.create` route refuses a blank source ("Pick where the job came from. Unknown is fine."). Voice memo jobs still default to Other.
- **Supervisor missing:** `jobs.list` and `jobs.get` return `supervisorMissing` (job has a builder company and no supervisor; imported and private jobs are left out). Badge on the Jobs list, warning box on the job's Supervisor card. Clears once a supervisor is set.
- **Duplicates:** `people.companyMatches` for companies, the existing contact matcher for people.
- **Address autocomplete:** `routes/places.ts` (`places.enabled`, `autocomplete`, `details`), Google Places API (New). Office roles only, Crew gets 403. Needs a Google Maps Platform key in the env (name is in `routes/places.ts`). With no key it falls back to plain typing.
- **Web:** `components/new-job-modal.tsx` (replaces the old modal in `pages/jobs.tsx`), `components/new-records.tsx` (new contact, company and site fields, match offers), `components/supervisor-picker.tsx` (`SupervisorPicker` on the job page, quotes and quote builder now uses the full supervisor form and saves at once; `SupervisorDraftPicker` for New job). "Who gets the invoice" lists the contact, company, supervisor, people on the draft, and "Someone else (add them)", which opens Add person with Accounts ticked.
- **Add person:** the People popup has "Not in Ops yet? New person", so a person can be made and added in one step. The old "add them under Clients first" hint is gone.
- **Next:** item 6, then 7, then 8 + 9 + bundle labels. Each needs Damien's OK on its touch list first.

### 18.8 Create quote on the job page, later-version hold, phone crash guard (10 Oct)

Checked: lint clean, web build, API tsc 0, app tsc 172 (baseline), mobile tsc 0. Scratch tests: `item6/t-i6.tmp.ts` 72 pass, `crash/t-crash.tmp.ts` 27 pass (server reports), `crash/guard.tmp.ts` 51 pass over three runs (the phone guard with the phone modules faked). UI checked on a scratch vite (`crash/teamui.py`).

**Item 6: Create quote from the job page.** No database change. No phone build.

Scratch test `terra-scratch-tests/item6/t-i6.tmp.ts`: 72 pass, 0 fail. UI checked on a scratch vite (`item6/i6ui.py` office, `item6/i6pub.py` client link).

- **Create quote:** two buttons on the job page (header and Quotes card) open `components/create-quote.tsx`. It offers the open draft first, otherwise Copy the latest version (lines, bundles and people as the next version) or Blank. The deposit box says where its number came from: copied from the version and the card, the company default, or "Typed for this quote only". The popup is portalled to the page body, because the dark job header made its fields white on white.
- **API:** `lib/quote-for-job.ts` (`createForJob`, built on `createQuoteRecord` and `reviseQuoteRecord`), route in `routes/quotes.ts`, query in `web/queries/quotes.ts`. The job's start date and people carry over (`jobStart`).
- **Later-version hold:** `laterVersionHold` in `lib/quote-accept.ts`. While a job has an accepted quote, a later version cannot be accepted until item 7 (replacing tasks and materials) is built. It is enforced inside `acceptQuote`, so online, office and builder all hit it. The client sees "This quote is being updated" with no Accept button. Staff see why. The builder's Accepted button is off with "Can't be accepted yet".

**Phone crash guard (Damien's Android report: black screen, then it closes, and only a reinstall fixes it).** Ships as an over-the-air update. No database change.

- **Cause found:** the sign-in clients read the saved login from the phone's secure storage while the app was still loading, with nothing catching a failure. If Android can no longer unlock that saved value (it can lose the key it was locked with, for example after a restore or an OS update), the read throws on every launch, before any error screen exists. A reinstall wipes the storage, which is why that was the only fix.
- **`lib/crash-guard.ts`** (imported first in `app/_layout.tsx`): every read of the saved login goes through `safeGet`, which never throws. An unreadable value is wiped and the phone lands on Sign in. A crash before the first screen is counted; after two in a row the saved login is wiped before anything loads (`safe_start`). It also notes when an update failed and the phone fell back to its built-in copy (`emergency_launch`). Problems are kept on the phone in a ring of 10 slots (each under 2 KB) so a crash cannot lose them.
- **`components/startup-screens.tsx`:** "Terra hit a problem" with Try again and "Sign out and start fresh" (catches screen errors and fatal errors once the app is up, instead of closing). "Can't reach Terra" with Try again, shown when the server does not answer and a login is saved, instead of throwing the person out to Sign in.
- **Sign in** (`app/login.tsx`) explains itself: "Your login expired. Sign in again." or "Terra had trouble reading your saved login on this phone, so it signed you out. Sign in again." A sign-out the person chose (Me tab) shows nothing.
- **Fonts:** the first spinner gives up after 4 seconds and carries on with the phone's own font.
- **Crash reports:** `lib/crash-report.ts` sends kept problems on start and each time the app comes to the front. Server `devices.reportProblem` (works signed out, max 10 per call, 120 per hour across all phones) stores them in `activity_log` as `entity_type = app_problem`. `devices.problems` (Admin) lists them. Web: People page, "Phone problems" card, newest first (8 shown, "Show more" for the last 50), click a row for the phone, app version, update id and stack. The dashboard's recent activity leaves them out.
- **Not Sentry, for now:** Sentry needs a native library, a store rebuild and its own account. The in-app reports cover the same ground for this crash. It can be added on the next phone build.
- **Next phone build:** set `android.allowBackup` to false in `app.json`, so Android does not restore an old saved login onto a new phone (a likely trigger for the unreadable value). Not done here: native change.

**iPhone build failing at "Prepare credentials"** (distribution certificate password): the repo does not supply the certificate. It is made by the publish pipeline, so it is for Runable support, not a code change.

### 18.9 One job per quote, later versions swap the work over (item 7, 10 Oct)

No database change. No phone build. The live database had no quotes, quote people or job materials when this was built, so nothing needed moving.

Checked: lint clean, web build, API tsc 0, app tsc 172 (baseline), mobile tsc 0. Scratch test `terra-scratch-tests/item7/t-i7.tmp.ts`: 116 pass, 0 fail. UI checked on a scratch vite (`item7/i7ui.py` New quote, `item7/i7ui2.py` accept notices, job page).

Damien's rules (10 Oct): ordered materials are never removed, only flagged. Anything flagged goes to the office as a notification listing it. Crew are only told when the office changes something by hand. Dispatches are only swapped while unassigned; offered or booked ones stay and are flagged.

- **New quote makes the job.** The New quote popup on the Quotes page now has a required "Where it came from" (same list and message as New job) and sends `makeJob`. `createQuoteRecord` (`routes/quotes.ts`) calls `createJobForQuote` (`lib/quote-convert.ts`), so the job exists at Lead from the start with the quote's number. The job log says "Job made with quote ...". The old path (a quote with no job, converted on accept or with "Turn into a job") still works for old quotes and for voice drafts (`routes/voiceQuotes.ts` still makes quotes with no job; left as it is).
- **One list of people.** A quote on a job has no people of its own. New quote and Create quote put people straight on the job (`addJobPerson`). New version does not copy quote people when there is a job. The quote page shows the job's people card ("People on this job", `QuoteJobPeople` in `pages/quote-builder.tsx`). The quote people routes refuse a quote on a job ("This quote is on a job, so its people are the job's people. Add them on the job's list."). The quote email goes to job people who get email or can approve quotes (`quoteRecipients` in `lib/quote-email.ts`). When a job is made from a quote, every version's people move onto it and the quote rows go.
- **Filling the job in later:** a New quote started with nobody picked makes a blank job. When the quote then gets its customer, company or site (`setCustomer` or `update`), `fillJobFromQuote` fills whatever the job is still missing: customer, site, access notes, the address as title, and billing while the job has no invoices. It never overwrites what the job has.
- **The hold is gone.** `laterVersionHold` and every screen of it (client "being updated" page, builder banner, Create quote warning) are removed. Any version can be accepted.
- **First accept on a job** (`lib/quote-accept.ts`): when no version of the quote has made work on the job yet, labour, prep and removal lines become unassigned dispatches and supply and accessory lines become materials to order (`buildWorkFromQuote`), logged `work_made`. Dispatches already on the job keep their places at the front. If a dispatch or material added by hand matches a line, Ops still makes the quote's one and flags the double.
- **Later version accepted** (`lib/quote-rework.ts`): the base is the version the work was last made or swapped from (`converted`, `work_made` or `work_swapped` in the job log). Dispatches are matched to the earlier lines by wording, materials by product (or wording when there is no product). Free ones (dispatch unassigned with no installer, no open offer and no booked day; material To order and on no purchase order) are updated, cancelled or removed. New lines are added. Locked ones are never changed and are flagged: offered, booked, started or done dispatches; materials on a purchase order, ordered, on site or installed. Rows that match no line (a measure, anything added by hand) are left alone. Logged `work_swapped` with every change and "To sort:" line.
- **The office is told:** the accept's office task is titled "Sort N things on job X, quote Y" and lists "Ops changed" and "To sort by hand (crew have not been told)". The office gets a push listing up to 4 flags and "And N more on the job." Crew get nothing. The builder's accept notice says how many changes were made and how many need sorting.
- **Unchanged:** the deposit stays the first accepted version's. A dearer later version raises a variation invoice as before.

### 18.10 Wastage and auto install labour, bundle labels (items 8 and 9, 10 Oct)

Live database changed 10 Oct by script after a full backup (`backups/terra-live-pre-wastage-2026-10-10.db`) and Damien's OK. SQL: `api/database/sql/2026-10-10-wastage-labour.sql`. No phone build.

Checked: lint clean, web build, API tsc 0, app tsc 151 (new baseline, none in the new files), mobile tsc 0. Scratch test `terra-scratch-tests/item8-9/t-i89.tmp.ts`: 127 pass, 0 fail. UI checked on a scratch vite (`item8-9/i89ui.py`).

Damien's rules (10 Oct): one measured m² per floor plus his wastage %, editable on every line. Box goods (hybrid, engineered timber, vinyl plank, laminate, carpet tiles): material is measured plus wastage, rounded up to full boxes, and labour is the measured m² only. Broadloom (carpet, sheet vinyl, turf): material and labour both include the wastage, and carpet lm rounds up to the next 0.1. Install is ticked on by default and can be unticked or swapped. Carpet with no width and the timber install type are flagged to ask, never guessed.

- **Database.** `products.sold_as` (box or broadloom, null when not a floor). Live tags: carpet 510 and turf 7 broadloom; carpet tiles 408, hybrid 254, laminate 106, timber m² 478 and vinyl 826 box; vinyl 710 broadloom (sheet). Hurford's 495 timber rows sold per lm stay null until Damien moves them to m². Plywood (`sheet_goods`, 13) stays null. New nullable `quote_items` columns: `measured_m2`, `wastage_pct`, `roll_width_m`, `labour_for_item_id` (the install line points at its product line), `rate_item_id` (the labour rate it came from).
- **The sums** live in `api/lib/flooring-qty.ts` (no server imports, so the builder shows the same numbers before adding). `autoSoldAs` tags new products the same way as the SQL. Vinyl with box data is box even when it also has a roll m².
- **Install items** (`INSTALL_ITEMS`): carpet 3.66 m is 1 and 4.0 m is 2, carpet tiles 4, vinyl plank 17, sheet vinyl 19, hybrid and laminate 15 (Damien renames 15). Timber is flagged with `TIMBER_FLAG`. Turf has no install.
- **Wastage defaults** are settings keys `wastage_pct_<type>`, edited on the Settings Wastage card. A missing key reads as 0%.
- **Quote routes** (`routes/quotes.ts`, helpers in `lib/quote-labour.ts`). `addProduct` takes measured m², wastage, width and the install tick or swap. `updateItem` makes the install follow the product line unless its qty was typed by hand. Deleting a product line deletes its install. `changeProduct` swaps the default install (for example hybrid 15 to vinyl 17). If the swap fails, the line is flagged "Install not swapped" and the old install stays. `addLabour` with `forItemId` adds a hand-picked install for a flagged line. New versions copy the columns and remap the links. Crew get 403. Office does not see costs.
- **Voice quotes** (`routes/voiceQuotes.ts`) use the same wastage and add the install when the draft has none. If that fails, the line is flagged "Install not added".
- **Web.** New `components/floor-area.tsx` (Measured, Wastage, install tick) in the product picker. Line notes read like "20 m² + 10% = 22 m². 14 boxes". The Products page has a Sold as column, filter and edit.
- **Bundle labels.** Vinyl tagged broadloom goes in the new `sheet_vinyl` bundle, "Sheet vinyl supply and installation". `sheet_goods` is now "Subfloor sheeting supply and installation" (plywood). An install line goes in its product line's bundle.
- **Known side effect, not acted on:** plywood is in `FLOOR_CATEGORIES`, so a plywood line with no labour triggers the quote check's `no_labour` warning.
- **Held:** items 11 and 12 wait until Damien has tested wastage on real quotes.

### 18.11 Fix list 11 Oct: items 1, 10, 11, 14, the dash sweep (branch fixlist-1011, not merged)

Branch `fixlist-1011` in the worktree `/home/user/terra-fix`. Pushed, not merged into `main`. Nothing here is live until Damien OKs the merge and publishes. No phone build: every change is web and API only.

Checked on the branch head: lint clean, web build OK, API tsc 0, mobile tsc 0, app tsc 138 (new baseline, down from 151; see the supplier hooks below).

- **Item 11, quote email wording** (`08ccb4a`). The wording comes from Settings with a friendlier default. The deposit shows in dollars from the quote, never a percentage, plus the valid until date. The office types what the quote is for each time, and Send stays off until they do. Scratch test `fix1011/t-i11`.
- **Items 1 and 10, categories and roll widths** (`38cb84d`). `api/lib/product-categories.ts` is the one list. `timber` is split into `engineered_timber` and `solid_timber`, and `outdoor_carpet` is new for the MJS 2.0 m ranges. `isTimberCategory` and `categoriesForHint` keep install labour, wastage, SWMS, bundles and voice quotes working for both, and still read the old `timber`. New and moved carpets get their width by rule: 3.66 m, or 4.0 m for the Belgotex ranges on the fix list. Scratch test `fix1011/t-i10`, 75 pass, 0 fail.
  - The live data move is a script, not applied: `terra-scratch-tests/fix1011/fix-i1i10.tmp.ts`. Dry run counts: solid 552, engineered 421, MJS to outdoor 6, widths 349, Belgotex 4.0 m 145. Apply only after the merge, the publish, a fresh backup and Damien's OK.
  - The seed files still say `category: "timber"` and still have long dashes. They only run on an empty database, so they were left.
- **Dash sweep** (`5143e8c`). Long dashes taken out of UI and message text in 42 files: commas, full stops, colons or "to". Empty values show "-". The restocking clause (15 to 20 percent) keeps its dash on Damien's word. The data side (3467 rows in products, fee rules and supplier text) is a script, not applied: `terra-scratch-tests/dash/fix-datadash.tmp.ts`, counts in `expect.json`, preview `datadash-preview.csv`. Activity log, mail and contacts are left alone.
- **Item 14, supplier delivery rules on POs** (`406bfe9`). New columns `suppliers.delivers_to` and `supplier_fee_rules.applies_to` (warehouse, site or both, default both). SQL `api/database/sql/2026-10-11-supplier-delivery.sql` also sets EC (15) to warehouse and Hurford's crane (fee 766) to site. **The SQL must go on live before or with the publish, or the PO pages break.** Script `terra-scratch-tests/fix1011/fix-i14sql.tmp.ts`, refuses if a column already exists.
  - `lib/purchase-orders.ts`: the old rule dropped every delivery fee on a warehouse order. Now each charge's `appliesTo` decides. The PO notes say which charges were left off and why. `routes/purchasing.ts` refuses a site PO for a warehouse-only supplier. The PO screen disables the Site button with a note and picks the right one on supplier change. The PO PDF says "Freight to our warehouse" or "Freight to site".
  - Suppliers page: "Where they deliver" on the freight card, "Goes on" on each charge.
  - **Bug fixed:** `feeUpdate` used a zod 4 `.partial()` of the create schema, which keeps the defaults, so any one-field charge edit reset the rest of the rule. It now has its own `feePatch` schema. On live only fee 768 was edited since the rules were re-seeded on 30 Sep, and it looks intact.
  - Scratch test `fix1011/t-i14`, 67 pass, 0 fail. UI check `fix1011/i14ui.py`.
  - Finding, not changed: supplier freight and baling are not built into the client sell price. The sell price is cost × 1.3 × 1.05 × 1.4 and `pricing.ts` keeps charges as their own lines. Freight is only covered by the general overhead today. Waiting on Damien.
- **Supplier hooks** (`74215e6`). `web/queries/suppliers.ts` had one helper keyed by a union of procedure names, so every supplier mutation was typed as the supplier update. Each hook now calls its own procedure. Same behaviour at run time, 14 type errors gone.
- **Live changes made on 11 Oct, each after a backup and an OK:** job 4226 (188000) back to one dispatch (`backups/terra-live-pre-4226-2026-10-11.db`), EC order email `customercare@eccarpets.com.au` (`backups/terra-live-pre-ecemail-2026-10-11.db`). Stripe live webhook made at `/api/webhooks/stripe`; it answers 404 until the publish.

### 18.12 Items 2 and 3: whole boxes, lengths, pails and rolls, underlay follows its floor (11 Oct, merged)

`a8a4bc1` on `main` (branch `fixlist-1011`, commits `50bf45e` and `a8a4bc1`). Web and API only, no phone build. Checked: lint clean, web build OK, API tsc 0, mobile tsc 0, app tsc 138 (baseline). Scratch test `fix1011/t-4a`, 113 pass, 0 fail. UI check `fix1011/i4aui.py`.

- **Sums** in `api/lib/order-sizes.ts` (pure): box goods round up to whole boxes, note "10 boxes (22 m²)" (Damien's exact wording, also in `lib/flooring-qty.ts`). Trims (accessory, lm) round up to whole `piece_length_m` lengths, "3 lengths of 2.4 m (7.2 lm)". No length flags the line, except weld rod (named weld rod, or a `length_mm` coil). `bulk_kind` is not used for this: it defaults to `roll` for new products. Each, pail and roll units round up to whole ones.
- **Underlay** in `api/lib/quote-sizes.ts`. Two categories, `carpet_underlay` and `hard_floor_underlay` (`lib/product-categories.ts`; old `underlay` still reads as hard floor). `quote_items.follows_item_id` links an underlay line to its floor line. Carpet underlay lm = carpet lm × (carpet width ÷ underlay roll width), rounded up to 0.1 lm, never down. Hard floor underlay = floor m² plus wastage. The qty follows when the floor's qty, product or width changes. A typed qty stays and shows "Typed over" with a "Use the floor qty" button. Removing the floor removes its underlay. `linkUnderlay` links voice quote underlay to the floor said before it, else the next one, else flags it.
- **Quote page:** a Follows select on underlay lines (choices show qty and unit), the size note under each line. Office only, the client quote never shows metres or cost. Bundles put a following underlay in its floor's bundle (`lib/bundles.ts`).
- **POs** (`lib/purchase-orders.ts` `orderSize`): roll goods use `roll_length_m`. Stocked (`held_in_warehouse`) reads "Cut from stock", not stocked orders whole rolls. No roll length or length size puts a note on the PO line to check it.
- **Settings, price list:** the old "Stocked" checkbox was really the Active switch. Now Active (`product_active_<id>`) and Stocked (`product_stocked_<id>`) are separate. A Sizes button per row edits roll width, roll length, length and wastage. New product has the same fields. `default_wastage_pct` beats the Settings wastage.
- **Live data, 11 Oct** (backup `backups/terra-live-pre-4a-2026-10-11.db`, dry run on a copy, Damien's OK, script `terra-scratch-tests/fix1011/fix-4a.tmp.ts`): SQL `api/database/sql/2026-10-12-lengths-underlay.sql` added the 4 columns. The 12 underlays moved to `hard_floor_underlay` (none on a quote line). `piece_length_m = 2.4` on the 31 active Floor Distributors scotias (9 Designer Profile, 22 Viva). The 3 Hurford's Genuine Oak nosings stay flagged until Damien checks their length.
- Not done: an "Includes ... underlay" mention in client bundle wording (`agent/bundle-wording.ts` already covers underlay).
- **Published 11 Oct** (Damien). Live bundle checked. Then the timber split went live (backup `backups/terra-live-pre-timber-2026-10-11.db`, dry run on a copy, his OK of the 552 / 421 grouping, script `fix1011/fix-i1i10.tmp.ts`): 552 to `solid_timber`, 421 to `engineered_timber`, 6 MJS to `outdoor_carpet`, 349 carpet widths (EC 236 and Victoria 91 from none to 3.66, Chaparral 22 from 3.6 to 3.66). 1328 product rows, each logged in `activity_log`. Carpets now 3.66 m = 359, 4.0 m = 145. No `timber` left.
- Items 6, 7 and 13 confirmed live on 11 Oct (Stripe webhook answers 400 to an unsigned post). Touch list report: `/home/user/terra-touch-6-7-13.report/content.md`.

### 18.13 Item 14: supplier freight inside the quote line price, carrier rules live (12 Oct, merged)

`92e5fae` on `main` (branch `fixlist-1011`, commits `ccad3ad` and `92e5fae`). Web and API only, no phone build. Checked: lint clean, web build OK, API tsc 0, mobile tsc 0, app tsc 138 (baseline). Scratch tests `fix1011/t-fr` 60 pass, `fix1011/t-car` 14 pass, re-run of t-4a 113, t-i13 119, t-i11 51, all 0 fail. UI checks `fix1011/frui.py` and `fix1011/carui.py`.

- **Freight in the price** (`api/lib/quote-freight.ts`, Damien's answer 5). Each supplier on a quote is one order. Its automatic charges (freight, baling, fuel, levies) are worked out with the PO rules for where that supplier delivers, then spread over that supplier's material lines in step with each line's cost and added to the cost per unit. Sell moves at the line's own markup, so freight is recovered at the same margin. The client never sees a freight line. The office sees "includes $X freight" under the line and a freight box on the quote page; staff without cost access see none of it.
  - `quote_items.freight_unit_cost` holds the freight part of the cost per unit, so recalc can take it out and put it back when qty or lines change. `refreshQuoteFreight` runs on every recalc. Revise, `changeProduct` and `hideCost` carry or reset it.
  - Typing a cost over a line sets `freight_unit_cost` to null (`updateItem`), so a typed cost is taken as final and freight is not added on top.
  - Accepted, declined, expired and replaced quotes are never touched.
  - Quote vs PO: a supplier who does not deliver (`delivers_direct = 0`) still costs Terra the carrier's bill, so quotes count carrier rules. The PO leaves them off because the carrier invoices Terra separately.
- **Per-block charges** (`supplier_fee_rules.unit_block`, `pricing.ts` `blockUnits`). A rule can be charged per block of N units or part, eg $35 per 40 lm or part (40 lm = $35, 40.1 lm = $70). Suppliers page: "Charged per block of (optional)" on a new charge, hidden for per order, per shipment and percent. The rule list shows "per 40 or part".
- **Pallet count:** a quote counts 1 pallet per supplier order whenever boxed goods are on it. Damien, 12 Oct: keep it at 1 for now. Later he will enter a pallet size on every product (not part of this fix).
- **Live, 12 Oct** (backups `backups/terra-live-pre-freight-2026-10-12.db` and `backups/terra-live-pre-carriers-2026-10-12.db`, dry run on a copy, Damien's OK "go live once the rules are fixed", script `fix1011/fix-carriers.tmp.ts`): SQL `api/database/sql/2026-10-12-quote-freight.sql` (both columns). Fee rules 47 to 58:
  - Unified Transport $123.50 a pallet ($95 + 30% fuel), auto, warehouse: ArtiFloor, Big Panda, Chameleon, Floor Distributors, Riverhill, NFD (rules 800 to 805).
  - Chaparral: Jocks roll freight $31.25 auto (806), Jocks pickup $20 tick (807). Advantage Jocks pickup (799) back on as tick only.
  - Chameleon 758 "Baling / dispatch fee" $50 per order, auto. Hurford's broken pack 765 tick only.
  - Victoria 772 "Baling and delivery" $35 per 40 lm or part, auto. 773 off. New fuel $15 per order, auto (808).
  - ArtiFloor 771 and NFD 776 freight off. Terramater fuel 1.5% auto (809), card 1.5. Gibbon delivery $80 per order auto (810).
  - Suppliers: delivers_direct off for ArtiFloor, Riverhill, NFD; on for MJS. Freight method text updated on 8 cards.
  - Live had 1 quote (accepted) and 0 open quotes, so no quote prices moved.
- **NFD later:** if NFD say they deliver, tick "delivers direct" on their card, switch rule 805 (Unified) off, and add or switch on their own delivery rule.
- Not built yet: Unified's other runs (Yatala, Caboolture, Redland Bay $75, Ballina $120), Jocks double pallet over 1.2 m, delivery modes and order emails (later, per the 11 Oct answers).

### 18.14 Items 4 and 5: price list import and export (12 Oct, merged a65e294)
- Settings, Price list (Admin only, office sees "Admin only"): Download template, Export price list (CSV or Excel, uses the search and Show discontinued), Import CSV (takes .csv or .xlsx), Undo last import, Import log (last 20).
- Import always previews first: counts for updates, new, discontinued, same, errors (skipped) and warnings. Price changes show amber. Nothing saves until Confirm import. If the price list changed between preview and confirm, confirm is refused and he previews again.
- Matching: terra_id, then sku within the supplier, then supplier + brand + range + colour. More than one hit is an error. Blank cells keep what is there. Sell rounds to 10c; a new product with no sell gets the standard markup.
- Undo works newest first. It puts back only fields still equal to what the import wrote, so hand edits after the import are kept. New products used on a quote, job, PO or account are set discontinued instead of deleted.
- Code: lib/price-sheet.ts (pure), lib/price-xlsx.ts (exceljs 4.4.0), lib/price-import.ts, routes/priceImport.ts, queries/price-import.ts, components/price-import.tsx.
- Schema live 12 Oct: products.roll_price, tables price_imports and price_import_rows (sql/2026-10-12-price-import.sql). Backup before: backups/terra-live-pre-price-import-2026-10-12.db.
- Dunlop loaded 12 Oct by script through the same code (imports 1 and 2, actor "Runable for Damien"): 379 from the price file and 23 from the underlay file, 0 errors, 0 warnings. Dunlop (supplier 23) now has 402 products; 4399 in total. Backup before: backups/terra-live-pre-dunlop-load-2026-10-12.db. The 241 lm trims carry 2.4 m lengths.
- Known: the Price list tab still draws every row at once (4399). Fine on a normal browser, slow in the sandbox.
- 12 Oct: Gibbon Group card (supplier 25) filled in: 14b Moonbi St, Brendale QLD 4500, 07 3881 1777, info@gibbontrade.com.au, ABN 71 145 382 556 (in notes, the card has no ABN field). Product 9529 (Sureboard, inactive) linked to it. Backup before: backups/terra-live-pre-gibbon-2026-10-12.db.
- 12 Oct: logo on the PO PDF (3781d3c), header now matches the quote PDF. Client invoices have no PDF; the pay page already shows the logo. The variation document gets the logo when item 12 builds it.

### 18.15 Insurance builders and supervisors import (12 Oct, merged b4e7b8f)
- Source: Damien's file `insurance-builders-supervisors-import_KBywd6.csv` (34 people, 8 companies). Plan and dry run: `terra-scratch-tests/supimport/plan.py` (options used: `--dane=two --qat215=move --prime=file --matt-mobile=keep`), report `supervisor-import-dry-run/content.md`. Scratch API test `supimport/t-sup.tmp.ts` PASS 27, UI check `supimport/supui.py`.
- Code: company type `insurance_builder` ("Insurance builder"), `isBuilderType()` in `lib/person-tags.ts` gives it the 0% deposit default. `journey-engine.ts` `enrol()` refuses anyone linked to an insurance builder company, so the quote follow-up is off for them. Companies get `compliance_email`, `admin_email`, `work_order_prefix`, `work_order_sender` (sql `2026-10-13-company-work-orders.sql`). The accounts email stays in `companies.email`, which invoices use. Company card shows and edits all four; People here shows title and phone.
- Live 12 Oct (backup `backups/terra-live-pre-supervisors-apply-2026-10-12.db`, 87 statements in one batch, 35 checks passed):
  - Types set to insurance_builder: 19 Ambrose, 73 Commerce, 104 Ezy, 188 Nexus, 210 Prime, 219 QAT, 224 Responsive, new 290 Repair & Rebuild. Emails and phones replaced from the file (Ezy keeps taylor.harris@, none in file). Prime is now pbaaccounts@.
  - New 291 Schuurman Trading (type other, dane@schuurmantrading.com.au).
  - 32 new contacts (source builder, audience trade, no marketing) plus 2 existing: 1135 Matthew Campbell (email now matthew@repairrebuild.com.au, shane@ removed everywhere, mobile kept) linked to Repair & Rebuild; 1231 Dane stays on the trading email, linked to Schuurman Trading as owner. New 1683 Dane under QAT with dane@qat.com.au. Both Dane cards carry a same-person note. QAT work goes to 1683. Dane's 5 personal jobs stay on 1231.
  - 215 "Qld All Trades" (QAT duplicate): 7 jobs (company and bill to) and 6 sites moved to 219, card made inactive.
  - Counts after: companies 290, contacts 1689, company_contacts 41.

### 18.16 Item 12: variations, sign only, final or end invoice (12 to 13 Oct, merged 0619326 and f1e4888)
- After a quote is accepted, Create quote on the job page is blocked with "Quote ... is accepted, so changes now go on a variation." Changes go through the Variations card on the job page (hidden on a not chargeable callback).
- A variation is priced like a quote (price book, rate items, own lines), refs V<job>-01, V<job>-02 (VR<job>-<n>-01 on a repair). Logo on the PDF. Sent by email with a link /v/<token>; the client signs online, or staff press Accepted.
- Damien's rules 13 Oct: sign only, no card and no bank details anywhere; never a separate invoice and never a new deposit. It stays `approved` and goes on the final invoice (homeowner) or the end invoice (company billed). `BILL_MODES = ["final"]`; `invoiced` and `invoice_id` are kept only for old rows (live has none).
- Accept (lib/variation-accept.ts): locks it once, adds the total to the job value, makes its work once (labour, prep and removal lines become a new unassigned dispatch, supply and accessory lines become materials to order), office task, log line, push when signed online.
- Company billed job: `WORK_ORDER_WARNING` "Get an updated work order from the supervisor that covers this variation before invoicing." shows on accept, in the office task, in the push and on the card. The public page never shows it. A numeric check against the work order comes with the work order build (spec Part 5).
- Signed copy: one page PDF (`onePage`, no photos, reason cut to 6 lines, extra lines summed as "Plus N more lines"), emailed to the client and filed in `job_media` bucket `signed` ("Signed documents"). `OFFICE_ONLY_BUCKETS` in routes/media.ts; field.jobFile hides it from crew. Photo picks skip the signed bucket.
- Code: lib/variations.ts, lib/variation-send.ts, lib/variation-accept.ts, lib/variationPdf.ts, routes/variations.ts, routes/publicVariation.ts, components/variations.tsx, pages/public-variation.tsx, components/public-shell.tsx, queries/variations.ts.
- Schema live 12 Oct: sql/2026-10-13-variations.sql (variations columns, variation_items, variation_signatures). Backup before: backups/terra-live-pre-variations-2026-10-12.db. The second round needed no SQL.
- Tests: terra-scratch-tests/fix1011/t-var.head.ts + t-var.body.ts PASS 164; UI check fix1011/varui3.py.

### 18.17 188001 list item 7: wording on an accepted quote, and the 188001 data fix (13 Oct, merged 3085fba)
- An accepted quote still lets Admin and Office fix section titles, section wording (including the AI rewrite) and line descriptions. Prices, qty, lines, line kind, section moves, bundle mode and the deposit stay locked; the server refuses them with "Only the wording can change". Declined, expired and replaced quotes stay fully locked.
- Server: quotes.updateItem takes a description only on an accepted quote (no recalc, money untouched, long dashes swapped for a comma by `cleanWording`). quoteBundles.update and regenerate use `quoteRow(id, "wording")`. bundlesFor never marks wording out of date on an accepted quote.
- Save and re-send: quoteSend.draft and send accept an accepted quote. The draft is an "Updated copy" email (price, quantities and deposit unchanged, nothing to sign or pay), PDF attached. Status, sentAt, price history and job stage are not touched. Logged as action `wording_resent`, "Wording edited, re-sent. Quote ... emailed to ...".
- No draft copies after acceptance: createQuoteRecord (plain create with a jobId) now also calls assertNoAcceptedQuote, on top of revise and createForJob. Line descriptions on the quote do not flow to job_materials.
- UI: quote-builder banner on accepted quotes, description inputs and section title and wording open, "Save and re-send" button (EmailQuoteButton `resend`). Quote assistant locked text and the client link "Not opened yet" fixed.
- Live data 13 Oct (Damien's OK, backup backups/pre-188001-data.db): Q188001-2 (quote 13, items 43 and 44, bundle 12) deleted with a history line on job 4227. Karndean Korlok 5G, Knight Tile Rigid Core and Van Gogh Rigid Core (82 products) moved from vinyl to hybrid. Q188001 bundle 7 key vinyl to hybrid, title "Hybrid flooring supply", "vinyl planks" to "hybrid planks". Total 5455.01 and job value unchanged. A later Karndean price import shows a category change in its preview if the sheet still says vinyl.
- Tests: terra-scratch-tests/fix1011/t-w7.head.ts + t-w7.body.ts PASS 52; UI check fix1011/w7ui.py. Data script: terra-scratch-tests/d188/s188.ts.

### 18.18 188001 list item 15: GST in GP, margin and cash (13 Oct, merged 13e0444)
- Rule: jobs.value stays inc GST (no data change). GP and margin use the ex GST value (value / 1.1). Cash in stays inc GST. Cash out adds 10% GST to every cost, except installer costs where installers.gstRegistered is false.
- New api/lib/gst.ts: GST_RATE, GST_FACTOR, exGst, incGst, costCashOut(amount, kind, installerGstRegistered), costHasGst(kind, installerGstRegistered). Use these, never a bare 1.1.
- finance.jobBudget: summary has value (inc), valueIncGst, valueExGst; grossProfit = valueExGst minus totalCost; margin over valueExGst; outBeforeReceipt uses costCashOut; each cost has hasGst. finance expenses rows carry cashOut (inc GST, what leaves the account).
- lib/cashflow.ts: out events are costCashOut amounts, basis gets ", plus GST" when GST applies. Cost amounts in job_costs stay ex GST.
- intel.ts: VALUE_EX SQL, costed_revenue_ex, gross_profit and margin ex GST. Revenue figures stay inc GST. lib/supervisors.ts and routes/costing.ts fallback revenue use exGst.
- UI: job Value shows ex GST with an inc GST line; Money out shows Contract ex GST, "Amount ex GST" column with an inc GST or "no GST" subline; Expenses page "Amount inc GST" with ex GST subline; Jobs list header "Value inc GST". New job modal: value typed ex GST, saved as x*1.1 with "Saved as $X inc GST" hint.
- Q188001 (job 4227): Contract $4,959.10 ex GST, $5,455.01 inc GST.
- Tests: terra-scratch-tests/fix1011/t-g15.head.ts + t-g15.body.ts PASS 44; UI check fix1011/g15ui.py.

### 18.19 188001 list items 9 and 13: Raise invoice and Mark delivered (13 Oct, merged 8142bc9)
- New api/lib/final-invoice.ts: billingOnJob(jobId) gives jobValue, billed (non void invoices), toBill (value less billed; value already carries accepted variations), finalRef, quoteRef, dueDay and termsText from resolveTerms, recipient (billed contact, else company accounts email), canRaise and reason (not accepted yet, non chargeable callback, all billed). raiseJobInvoice({jobId, kind final|stage, amount, label, completionDay}) caps the amount at toBill, allows one live final per job, due date from the payer's terms (from completionDay when terms run from completion).
- clientInvoices.billing and clientInvoices.raise (staffOnly). raise can email at once through sendInvoiceEmail; if the email fails the invoice stands and emailError comes back.
- New api/lib/delivery.ts + routes/delivery.ts: delivery.status and delivery.markDelivered. Supply only = an accepted quote with no labour, prep or removal lines and no live (non cancelled) job_tasks. markDelivered takes deliveredOn and proofs (storage keys must start jobs/<id>/completion/), files them in job_media bucket completion, sets completedAt (guarded on null), logs "delivered", moves the job to Complete, raises the final for what is left. The final is never emailed there.
- quote-accept: the Order product task says "No deposit on this quote. Raise the invoice from the job's Client invoices card" when nothing was raised on a first accept.
- INVOICE_KIND_LABEL stage is now "Progress".
- UI: Client invoices card has Raise invoice (kind, amount inc GST with ex GST and GST hint, wording, due date, Email it now ticked by default, Send to) and a "Not billed yet" line. New Delivery card (web/components/delivery.tsx) above it on supply only jobs, with the Mark delivered modal (date, proof files, note).
- Tests: terra-scratch-tests/fix1011/t-i913.head.ts + t-i913.body.ts PASS 111; UI check fix1011/i913ui.py (seed t-i913seed.body.ts).

### 18.20 188001 list items 8 and 10: colour check form, sent by hand (13 Oct)
- Item 10: accepting a quote no longer makes or sends the material selection form. The first accept's order task says "Send the material selection form from the job page so the client can check the colours before you order." The job's Material selection card has the Send button (clientInvoices.sendSelection, staff only). The quote builder notice line is gone.
- Item 8: the form is one section per floor product (FLOOR_CATEGORIES) plus trims and scotia that have a colour, taken from the accepted quote (productItemsFor, quoteSections). No accepted quote means Send is refused. createSelection reuses the newest form only when it is a product form for the same quote.
- Picker (rangeColours): same supplier, supplierId, brand, range, category, size, backing, unit, thicknessMm and widthM. Active only, with a colour, one per colour name, the quoted product wins a tie.
- Price change per unit (perUnitChange): cost difference times (1 + the line's markup), falling back to the sell difference. Same price swaps job_materials at once. Cheaper swaps at once and makes an office task (the office keeps the price or credits it). Dearer makes a draft "other" variation line, "Colour change, <title>: <from> to <to>, <qty>"; the materials swap when that variation is accepted (variation-accept calls applyAcceptedColours). A company billed job never sends the variation to the homeowner, the office handles it.
- One office task per form ("Colour change(s) to check, job X" or "Material selection note, job X"), an empty draft variation is deleted on resubmit, log line and push on every submit.
- Prices are hidden on a company billed job unless the form's contact is in company_contacts for that company (pricesShownTo). Then the page says "Costs more" or "Costs less", never a $ figure.
- Lock (lockState): any job_materials row ordered, on_site or installed, or jobs.completedAt set. Locked forms show the reason and no inputs; submit is refused.
- Swatches: products.swatch_key. Admin only products.swatchPresign (images only) and products.setSwatch (key must start products/<id>/swatch/, or null). Uploaded from Settings, Price list ("Add swatch" / "Swatch") or the price book variant modal ("Colour swatch"). No picture means the form shows the colour name in the box.
- Legacy room forms (no quoted product on the items) still open and submit through the old flow (RoomSelection). Lloyd's form 2 on job 4227 is untouched. Send on such a job makes a new product form.
- Public page /m/<token>: components/selection-products.tsx (ProductSelection, picker modal, "Thinking about a different colour? Change it here", "Anything else we should know?"). Staff card: SelectionSections in components/client-invoices.tsx. Code: api/lib/selection-colours.ts, lib/material-selection.ts, routes/publicPages.ts, routes/clientInvoices.ts, routes/products.ts, components/product-swatch.tsx.
- Schema: sql/2026-10-13-material-colours.sql (13 added columns, nothing dropped). Must be on live before the web publish.
- Tests: terra-scratch-tests/fix1011/t-i8.head.ts + t-i8.body.ts PASS 136; UI check fix1011/i8ui.py and i8ui2.py. The Settings Price list draws every product at once (4009 on live); the sandbox Chrome crashed on it, so the UI check switched off the other products in its scratch DB.

### 18.21 188001 list items 1, 2, 6 and 11: client layout, supply titles, delivery lines (14 Oct)
- Item 1: quotes.layout is auto, itemised or sections (default auto). Auto gives itemised when the quote is supply only (lines, and none labour, prep or removal: lib/quote-layout.ts isSupplyOnly), else sections. Itemised shows one row per line (description, qty, unit, rate, total, ex GST), delivery last (itemRows). The Layout select is on the "What the client sees" card (quoteBundles.setLayout, staff only, locked once accepted like the bundle mode). Itemised hides the Combined/Split toggle and the section preview, and the PDF prints an item table (quotePdf itemTable) with no section wording warnings. The public page (/q/<token>) gets layout and items and renders components/quote-item-rows.tsx. reviseQuoteRecord copies layout.
- Item 2: a section with no labour line is titled "<floor> supply" (defaultBundleTitle in lib/bundleCatalog.ts). Quotes that went out before TITLES_CHANGED_AT (routes/quoteBundles.ts, sentAt, else acceptedAt or createdAt when accepted) keep the old "supply and installation" titles. Saving a title that equals either default stores "" so it follows the lines.
- Item 6: quote line kind "delivery" (lib/line-kinds.ts). A hand typed line starting delivery, freight or cartage becomes delivery. Its tag is always Delivery, never Material or Labour (updateItem forces it). Kind pickers on the builder and variations show Delivery. The agent and voice quotes know the kind.
- Item 11: a delivery line is never a job_material or a PO line. On accept (buildWorkFromQuote) and on a later version (reworkJobForVersion) syncDeliveryCosts makes job_costs rows: kind other, state budget, amount unit cost x qty, notes DELIVERY_NOTE (lib/delivery-cost.ts). Only budget rows are changed or removed; committed, invoiced or paid ones are kept and flagged to the office. An accepted variation's delivery lines add the same Other cost (variation-accept addDeliveryCosts). Costing counts delivery in materials.
- Email: a supply only quote's draft says "arrange a delivery date that suits you" in place of "lock in an install date that suits you" (forSupplyOnly), also on a saved template.
- Schema: sql/2026-10-14-quote-layout.sql (quotes.layout). Must be on live before the web publish.
- Tests: terra-scratch-tests/fix1011/t-lay.body.ts (head from t-i8.head.ts with qa.lay logins) PASS 71, plus a default title check PASS 10; UI check terra-scratch-tests/fix1011/layui.py (builder layout select, Delivery tag, itemised preview, public itemised page).

### 18.22 Cancel job flow and test job clear (15 Oct)
- New api/lib/job-cancel.ts (cancelPreview, cancelJob) and routes/jobCancel.ts (jobCancel.preview, jobCancel.run, staff only). One confirm screen (web/components/job-cancel.tsx, CancelJobButton) on the job page and on an accepted quote in the builder. It lists every step before anything changes. Queries in web/queries/jobCancel.ts.
- Real cancel: job to Cancelled, the accepted quote to the new status "cancelled" (out of the win numbers, Intel counts accepted only). Unpaid invoices voided, paid ones kept with a refund or credit office task. Open dispatches cancelled and the booked crew pushed ({ kind: "task", taskId, jobId }, title "Dispatch <ref> cancelled"). Open office tasks closed. Draft and needs_review versions deleted. to_order materials removed. Unsent POs cancelled; a sent PO gets an office task to ring the supplier. Supplier bills stay as costs. Forecast rebuilt.
- Test job clear: admin only, the job number must be typed, logged test_job_cleared. Refused when the job has a card payment or a supplier bill on one of its POs. A sent PO with no bill does not block it. A bill that points at the job with no PO has its job link cleared.
- Status "cancelled" is locked everywhere a quote is locked (quotes.ts LOCKED_STATUSES, quoteBundles, quote-freight, quote-agent, quote-accept, supervisors). The public quote page shows "This quote has been cancelled" and refuses accept. revise refuses a cancelled quote. quotes.remove refuses accepted, replaced and cancelled and points at Cancel job.
- Builder: Versions card has an admin Delete on draft and needs_review rows. A cancelled quote shows a banner and no New version button. Quote list has a Cancelled filter and colour.
- No schema change (quote status is plain text).
- Tests: terra-scratch-tests/fix1011/t-cancel.body.ts PASS 148; dry run t-candry.body.ts on a copy of the live backup (188000 clear, 188001 preview only); UI check fix1011/canui.py.

### 18.23 188001 list item 14: run a supply job from the job page (15 Oct)
- New web/components/supply-steps.tsx (SupplyStepsCard), only on a supply only job (delivery.status supplyOnly). Sits under the header facts. Steps: Colours checked (optional), Ordered, Delivered, Invoiced, Paid. Each open step has a button that scrolls to the card that does it (STEP_ANCHOR ids) and flashes it. "Next:" names the first open step that can be done from here. Read only, it changes no data.
- Ordered reads purchasing.forJob (admin only). Office sees "An admin raises and sends the PO" and the PO is not offered as their next step.
- Invoiced is open while a live, unpaid invoice has not been emailed. clientInvoices.forJob now returns emailedAt per invoice (newest invoice_emailed activity row). The Client invoices card shows "Emailed <day>" or "Not emailed yet" on open invoices.
- Job page on a supply only job: Material selection, Materials and Purchase orders move up into step order before Delivery and Client invoices. The empty Dispatches card is hidden. Install jobs keep the old order.
- Tests: UI check terra-scratch-tests/fix1011/i14ui2.py (layout, office view, install job unchanged) and i14ui3.py (draft PO, sent PO, mark delivered, emailed, paid). Seed t-i913seed.body.ts on a /tmp copy.

### 18.24 188001 list item 16: Money out from the quote, supplier payment terms (16 Oct)
- Live schema (applied 13 Oct, backup backups/pre-expected-costs.db): suppliers.terms_days (integer, null means not set), suppliers.terms_eom (default 1), job_costs.source ('' by hand, 'quote', 'po'). SQL in database/sql/2026-10-15-expected-costs.sql.
- lib/supplier-terms.ts: termsOf, supplierTermsText (0 days and no EOM reads "COD"), termsForSupplier, supplierTermsMap. Not set falls back to 30 days EOM and the basis says "(terms not set)". Used by cashflow costDueDate and the forecast build, finance.jobBudget, payables (bills with no printed due date), invoice-match settlePo and commitPo.
- Supplier card (pages/suppliers.tsx): Payment terms field, days plus EOM tick. Admin only via suppliers.update (0 to 365 whole days).
- Live terms set 13 Oct (backup backups/pre-supplier-terms.db): 30 days EOM for Advantage, Belgotex, Dunlop, EC Carpets, Floor Distributors, Hurford's, MJS. COD for Tarkett, Victoria Carpets, Big Panda, Chameleon, Riverhill and every other supplier. Karndean left not set (30 days EOM used).
- lib/expected-costs.ts: on accept (buildWorkFromQuote) and on a version rework, syncExpectedCosts makes budget rows from the quote cost prices: one materials row per supplier, one installer row for labour, a "no supplier set" row for loose lines. Delivery lines stay with syncDeliveryCosts (Other). Lines with no cost price are named in the notes. Only source 'quote' rows at budget are touched, and a supplier with a sent PO is skipped.
- commitPo takes over that supplier's expected row (same id, committed, source 'po', due on supplier terms) so stock is never counted twice. cancelPo brings the expected row back from the accepted quote, except in a job cancel. A real job cancel removes the budget rows and says so in the preview.
- PO cost description no longer doubles "PO PO". Money out shows each row's notes, keeps them on edit, and a PO row's date reads "PO sent, on the supplier's terms".
- Tests: t-i16.body.ts with t-i913.head.ts (PASS 70), t-cancel.body.ts with t-i8.head.ts still PASS 148. UI check i16ui.py, i16ui2.py.

### 18.25 188001 list item 5: discount approval blocks Send for everyone, markup below standard (16 Oct)
- Live schema (applied 13 Oct, backup backups/pre-quote-price-by.db): quote_items.price_by ('markup' when the markup was typed, 'hand' when a sell price was typed, '' for price book or older lines). SQL in database/sql/2026-10-16-quote-price-by.sql. Version copies keep it.
- routes/quotes.ts assertReadyToGoOut: a discount over the limit that nobody approved now stops Send, Mark as sent, Email quote, Accept and Convert to job for Admin too. Admin message: "Approve it first, then send." Editing is unchanged (Admin can still edit past the limit, Office cannot).
- markupBelowStandard(item) gives { markup, standard } for a line priced by markup under the price list sell. Standard is list sell / cost minus 1, to the whole percent. Older lines with no price_by count as markup priced when the stored markup is not the one worked back from the price. belowListKind(items) is "markup", "discount", "mixed" or null.
- quotes.get: discountNeedsApproval no longer skips Admin, adds discountKind, and each item has belowStandard (null when costs are hidden).
- approveDiscount logs "Markup below standard of X% approved" or "Discount of X% approved" in the quote history.
- Quote builder: amber line note "Markup 35%, standard 91%", the bar says "Priced X% under the price list (markup below standard)" for markup lines, Admin button "Approve X% under list" or "Approve X% discount", and Accepted is disabled too while waiting.
- lib/quote-check.ts: the discount_limit stop applies to Admin too. The "discounted" warn uses the markup wording for cost viewers (CheckLine.belowStandard, built in agent/quote-agent.ts runCheck).
- Tests: t-i5.body.ts with t-i913.head.ts (PASS 65). t-i16.body.ts now approves before sending (PASS 71). t-i913 111, t-var 164, t-cancel 148 still pass. UI check i5ui.py (seed t-i5ui.body.ts).

### 18.26 188001 list item 8: installer cost table only once a dispatch has labour lines (16 Oct)
- routes/costing.ts forecast: hasLabourLines is true when any dispatch on the job has a labour line. comparison is empty until then, and the result returns hasLabourLines.
- components/costing.tsx JobForecastCard: the "Price all labour against" picker shows only when comparison has rows. The "What it costs on each installer" table needs hasLabourLines too. With nothing measured every installer priced at $0, so the table said nothing.
- No schema change.
- Tests: terra-scratch-tests/fix1011/t-i8c.body.ts with t-i913.head.ts (PASS 13): no lines, lines added, lines removed, office 403.

### 18.27 188001 list item 12: site is blank (16 Oct)
- New routes/siteFill.ts (siteFill): forQuote (needed when the quote has a delivery line, kind delivery or text starting Delivery, Freight or Cartage, and neither the quote nor its job has a site), forJob (needed when the job has no site, guess off its newest quote with a delivery line), save (quoteId or jobId, plus siteId or newSite). Staff only. Logs "site_added".
- Save on a quote: sets quotes.site_id (draft, needs_review or sent only), then fillJobFromQuote gives the job the site, access notes and the address as title. Save on a job: sets jobs.site_id, access notes, replaces a "Quote Q..." title, and its open quotes with no site take it. Accepted quotes stay as signed.
- lib/site-guess.ts siteGuessFromText: strips "Delivery to", reads a state and postcode at the end, and the part after the last comma as suburb when it is a few words with no numbers. Shared with the web.
- Web: components/site-fill.tsx SiteFillModal (NewSiteFields plus access notes, prefilled from the guess, shows the delivery line) and JobSiteFact on the job page ("No site. Add one"). Quote builder: Mark as sent, Email quote, Email again and Accepted open the form first when needed, then carry on. EmailQuoteButton has a gate prop. The server does not block Send or Accept without a site, and online accept is unchanged.
- No schema change.
- Tests: terra-scratch-tests/fix1011/t-i12s.body.ts with t-i913.head.ts (PASS 53). UI check i12ui.py (seed t-i12ui.body.ts). t-i913 still PASS 111.

### 18.28 Email check on every email field (17 Oct, ask B)
- Like ServiceM8. Red when the address is not an email (after leaving the field) or its domain can't take mail. "Did you mean bob@gmail.com?" shows for common typos and a tap fixes the field. Never blocks saving, and the input is type text so the browser never blocks it either.
- lib/email-typo.ts (shared with the web, no network): emailFormatOk and suggestEmail (known AU and global mail providers, edit distance 1 or 2 with letter swaps, ending fixes like .con, .comau, .com.u, comma for dot, "gmail" with no ending). A known domain is never changed.
- lib/email-check.ts checkEmail: MX lookup, then A or AAAA when there is no MX (RFC 5321). Null MX or no such domain is no_mail. A slow or failed lookup is unknown and never red. Cached per domain (6 h ok, 30 min no mail, 2 min unknown). Free, no key.
- routes/emailCheck.ts emailCheck.check (staff only). Web: queries/emailCheck.ts useEmailCheck, components/email-input.tsx EmailInput (value, onValueChange, 600 ms debounce). An address already on file is checked straight away.
- Fields: new contact and new company (new-records), clients New contact, contact edit, companies New company, company edit (accounts, compliance and admin), quote customer, voice memo, quote email, client invoice emails (3), supervisor move, team, supplier add, supplier owed, PO send, supplier invoice send. Not on login, public pages, the supplier detail (saves on blur) or the SWMS add list.
- No schema change.
- Tests: terra-scratch-tests/fix1011/t-em.body.ts with t-i913.head.ts (PASS 48). UI check emui.py. t-i913 PASS 111, t-i12s PASS 53.

### 18.29 Address autocomplete and site map pins (17 Oct, ask A)
- Live schema (applied 13 Oct, backup backups/pre-site-geo.db): sites.lat, sites.lng (real), sites.place_id (text), sites.geo_source (text, default ''). geo_source is 'google' when picked from Google's list, 'lookup' when the backfill found it, 'not_found' when the backfill could not confirm it, '' when typed and never checked. SQL in database/sql/2026-10-17-site-geo.sql.
- components/address-autocomplete.tsx AddressAutocomplete (value, onType, onPick), PickedAddress, billingLine, usePlacesOn. Google Places (New) suggestions with a session token per pick. With no key it is a plain box. Anything can still be typed and saved.
- Used on: new site (NewSiteFields in the new job modal and the site fill form), new contact home address, new company billing address, clients New contact, contact edit, companies New company and company edit (billing line).
- NewSiteFields hint: green "Checked with Google. Navigate goes to this pin." or amber "Not checked with Google. Pick it from the list if you can, or save it as typed." Editing any address field after a pick drops the pin. JobSiteFact shows amber "Not checked with Google" for a site that is not google or lookup.
- routes/places.ts details asks for location too and returns lat, lng and placeId. lib/job-new-records.ts siteGeoFields and withGeoSource (a full pin gives google, otherwise null and ''). sites.create takes the pin. sites.update: a new pin sets google, a typed change to address, suburb, state or postcode clears it, other edits keep it.
- Crew: crew-brief Brief.pin, voice navUrl uses the pin (Google destination_place_id or ll, Waze ll, Apple daddr=lat,lng). field.ts task list returns siteLat, siteLng, sitePlaceId. visits.targets returns lat and lng. Phone: task Navigate goes to the pin when there is one, and site-fences uses the pin before its own lookup. Needs a phone publish.
- Google key: GOOGLE_PLACES_API_KEY in .env. The Geocoding API is not used. The backfill uses Places Text Search.
- Backfill script terra-scratch-tests/site-geo/backfill.ts, results in results.json (3,037 sites: good 2,771, check 233, none 33). Phase 2 writes only lat, lng, place_id and geo_source, never the address text.
- Tests: terra-scratch-tests/fix1011/t-geo.body.ts with t-i913.head.ts (PASS 21). UI check geoui.py. t-i913 PASS 111, t-i12s PASS 53, t-em PASS 48.

### 18.30 188001 list items 3, 4 and 18: supply search, filters, last quoted (17 Oct)
- routes/productFind.ts. find (staffOnly, so Office can use it): search, category, thicknessMm, minSell, maxSell, sort (name, cheapest, dearest), limit up to 200 (default 40). Every word typed must match brand, range, colour, supplier, backing, SKU or size. Returns rows (no cost, sellExGst and onSpecial, plus the product shape fields useAreaDraft needs), total and thicknesses [{mm, n}] counted before the thickness pick. Discontinued products never show.
- lastQuoted (staffOnly, returns {} unless canSeeCosts): productIds, companyId, contactId, excludeQuoteNumber. Same range means supplier (id where there is one), brand and range, any colour. A product with a blank range only matches itself. Reads quote_price_history (written on Send). This client first (company, or contact when there is no company), then anyone. Returns per product {last, recent[5]} with unitPrice, unit, quotedAt, customer, quoteRef, colour, sameProduct, sameClient. The quote on screen and its other versions are left out.
- web/queries/productFind.ts useProductFind, useLastQuoted (FoundProduct, LastQuoted types). components/product-finder.tsx ProductFinder (search box, results under it, Filter panel with type chips, thickness from stored values, sell from and to, sort, Showing X of N, Show more up to 200, arrow keys and Enter) and LastQuotedNote ("Last quoted $59.07/m², Prime Shopfitting, 12 Oct", tap for the last 5).
- Used in quote-pickers ProductPicker (replaces the Pick one of N box, takes context companyId, contactId, number) and variations VariationProductPicker. The quote builder line shows LastQuotedNote under the description for cost viewers. Nothing on the client PDF or page.
- Thickness and wear layer: settings.productCreate and productUpdate take thicknessMm and wearLayerMm (over 0, up to 100). Price list tab shows them under the colour and edits them in Sizes and New product. lib/price-sheet.ts thickness_mm and wear_layer_mm at the end of the sheet columns, export and import (blank keeps, over 100 or not a number is a row error). No DB change.
- Old products.list is still adminOnly, used by the price list tab and Change product.
- Tests: terra-scratch-tests/fix1011/t-find.body.ts with t-i913.head.ts (PASS 71). UI check findui.py. t-i913 111, t-i12s 53, t-em 48, t-geo 21, t-var 164, t-imp 122, t-i16 71.

### 18.31 Price list import fills the Sizes (13 Oct)
Damien: the 4 new Sunstar Adare colours (Mother of Pearl, Torte, Willow, Keystone, ids 9935 to 9938) imported with board width, thickness and box m² but showed "-" under Sizes. The Sizes line is `size` text plus `{unitsPerPack} per carton · {packM2} m²` (packM2 = unitsPerPack x unitM2), and the sheet had no column for length or pieces.
- Live fix, his OK in the message: copied size "2200 x 194 x 12mm", lengthMm 2200, unitsPerPack 5, unitM2 0.4268 from Arctic Oak (6055). Width 194 and thickness 12 already matched. packM2Printed kept at 2.134 from his sheet (Arctic has 2.13; quotes use 5 x 0.4268 = 2.134 for both). Prices, names and tier untouched. Backup backups/pre-adare-sizes.db. Script terra-scratch-tests/adare/apply.ts (state check, refuses a second run).
- New lib/board-size.ts (pure, web imports it): boardSizeText(l, w, t) "2200 x 194 x 12mm", boardM2(l, w) 4 places, derivedBoardFields(before, next): size filled when blank or rewritten when length, width or thickness moves (a typed size is kept while the numbers stay), unitM2 filled when blank or worked out again when length or width moves.
- lib/price-sheet.ts: board_length_mm (lengthMm) and pieces_per_box (unitsPerPack, whole number 1 or more, else a row error) after board_width_mm, in export, template, parse and Patch. Patch also carries unitM2 and size (labels Board m², Size). Update rows derive only when the row moves a measurement, so an exported sheet sent back still changes nothing. New rows always derive. box_m2 equal to the stored printed figure or to boards x board m² is not a change. New boxMismatch warning (over 1%): "Box size comes from 5 boards x 0.4268 m², so box_m2 3 is saved but quotes use 2.134 m²." Replaces the old match-only warning.
- lib/price-import.ts preview: creates carry `sizes` ("2200 x 194 x 12mm · 5 per box · 2.134 m² a box"), shown under the name in the New tab.
- settings.productUpdate takes lengthMm, widthMm, unitsPerPack (int) and derives size and unitM2. Sizes modal on the Price list tab has Board length, Board width, Pieces per box and a "Now:" line.
- Price book (pages/products.tsx): Sizes falls back to the built size text when `size` is blank, and shows "2.134 m² per carton" when only the printed box size is known.
- Tests: fix1011/t-bsz.body.ts with t-imp.head.ts (PASS 62). t-imp updated for the column order (122). run2 all pass. Checks lint 0, api 0, app 138, mobile 0, build 0.

### 18.32 Quote lines line up, and the install follows the floor (13 Oct)
Damien's screenshot: on the quote builder the number values did not sit under their headings, and a Sunstar Adare (laminate) line got "Hybrid installation".
- pages/quote-builder.tsx: Qty, Sell, Cost, Markup % and Line total are right-aligned in the heading and the cell (inputs ml-auto, tabular figures). Unit is left-aligned. The % moved from beside the markup box into the heading ("Markup %") so the value ends under the heading. columnPlaces(items) gives every row in a column the same decimal places (at least 2, up to 4, from the longest value in that column), padTo pads the value, so values line up on the point. A value with more places than the column shows as is, so nothing gets rounded when the box is left. The phone uses the same page (the table scrolls sideways), so it lines up the same. Checked by measuring heading and box right edges at 1400 and 412 wide.
- lib/flooring-qty.ts: defaultInstall gives laminate item 16 (Laminate flooring installation, skill Laminate) and hybrid item 15 (Hybrid installation, skill Hybrid). INSTALL_ITEMS.laminate is [16] and hybrid is [15], so the install choice under a floor only offers its own install. floorForInstall, the voice "already covered" check and the area strip choices follow. A product change between hybrid and laminate swaps the linked install (quotes.changeProduct, item 8 logic, unchanged). Other floors unchanged: carpet 1 or 2 by width (else ask), carpet tile 4, vinyl plank 17, sheet vinyl 19, engineered asks (37 or 38), solid 39, turf and outdoor none.
- Labour rate: the line takes the rate of its own item (both are $28 on live now, rates 31 and 32).
- SWMS: the dispatch skill comes from the install's rate item, so laminate goes under skill Laminate. On live (checked on a copy of backups/pre-adare-sizes.db) Laminate brings in lib_laminate. Hybrid brings in nothing: the published "hybrid" template only matches "vinyl plank" and "lvt", and lib_hybrid (Hybrid floating) is not in the published library. Told Damien. No change made to the library.
- Live: quote 188002 (id 15, draft) line 54 "Hybrid installation" (item 15) sits under line 53 Sunstar Adare in Torte. Not changed. Asked Damien.
- Tests: fix1011/t-inst.body.ts with t-i913.head.ts (PASS 45). run2 now also runs inst, i10 (75), i8 (136) and 4a (113), all pass. Checks lint 0, api 0, app 138, mobile 0, build 0.

### 18.33 Supplier freight and charges as their own quote lines (13 Oct)
Replaces 18.13 (freight inside the product price). Damien's answers are final.
- Internal view (admin, and office with cost access): one line per supplier charge, kind supplier_charge, label "Supplier freight: Sunstar (1 pallet)". Carrier freight (Unified, Jocks) counts too. Sell is cost x (1 + pct/100). pct is the Settings key supplier_charges_markup_pct, default 15 (Settings, Business rules, "Supplier charges" card, 0 to 1000, blank is 15).
- Pallets are ceil(total boxes / boxes_per_pallet). A product with no boxes per pallet counts 1 pallet and flags the line to check. 10 Adare boxes: 1 pallet, $110 cost, $126.50 sell. 2 pallets: $220 / $253.
- The product line keeps its true price book cost and sell (Adare $21 / $40.13).
- Client copy (public quote page, PDF, email, invoice) and office without cost access: lib/charge-fold.ts spreads each charge sell into that supplier's product lines, so the lines add up to the total. The quote agent brief does the same for non cost viewers.
- A typed over line (qty or price) is set charge_typed and recalc leaves it as typed. Delete it to go back to the worked out line. A worked out line has no trash, no kind or type picker and no Change product. If the supplier's goods go, the line stays with the flag "No <supplier> goods left"; the flag clears when they come back (GONE_FLAG).
- Never on a supplier PO or on Materials to order. Expected costs put the charge cost under that supplier (chargeSupplierId). Costing goods() counts supplier_charge. The margin check skips charge lines.
- New quotes only. Locked statuses (accepted, declined, expired, replaced, cancelled) are never touched. Old drafts with freight_unit_cost (quote ids 11, 14 and 15) move over on their next recalc: the freight comes back out of the price and the charge line goes on.
- quotes.get returns supplierChargesPct for cost viewers (else null). The builder card is "Supplier charges": per supplier cost / sell, "(typed over)", the flag.
- Schema: quote_items charge_supplier_id integer, charge_key text, charge_typed integer not null default 0 (sql/2026-10-18-freight-lines.sql). Applied live 13 Oct with Damien's OK by script, after backups/pre-freight-schema.db (integrity ok). 28 to 31 columns, 22 rows unchanged.
- Live data, earlier with Damien's OK (backups/pre-freight-lines.db): quote 15 line 54 is now rate item 16 "Laminate flooring installation" (totals unchanged). Sunstar boxes_per_pallet filled from the CSV on 239 products.
- Web code must not import server modules: the constants the web needs (SUPPLIER_CHARGES_MARKUP_KEY, SUPPLIER_CHARGES_MARKUP_DEFAULT) live in lib/charge-fold.ts; quote-freight.ts re-exports them.
- Tests: fix1011/t-frl.body.ts with t-i913.head.ts (PASS 98, FAIL 0). The old t-fr.body.ts is retired as t-fr.body.v1.bak. Base DB /tmp/ti6.base.db (ti5 plus the 3 columns). run2 all pass: i913 111, i12s 53, em 48, geo 21, find 71, var 164, imp 122, bsz 62, i16 71, inst 45, i10 75, i8 136, 4a 113, frl 98. UI check fix1011/frlui.py on a scratch quote: admin row and card, type over to 140 (card shows typed over, trash appears), Settings shows 15, office sees one Adare line at $996.37 with no charge line, no page errors. Checks lint 0, api 0, app 138 (old), mobile 0, build 0.

### 18.34 Notifications to the office: alerts, push and email, no texts (13 Oct)
Fix list 11 Oct, item 15. Damien's answers are final.
- New table alerts (sql/2026-10-19-alerts.sql): id, kind, title, body, job_id (cascade), data JSON, read_at, read_by_name, emailed_at, pushed, timestamps. Indexes alerts_open_idx (read_at, created_at) and alerts_job_idx. Applied live 13 Oct with Damien's OK by script, after backups/pre-alerts-schema.db (integrity ok).
- lib/notify-kinds.ts (no imports, the web reads it): 21 kinds with label, group and urgent default. Urgent by default: quote_accepted, payment_received, swms_red, price_flag_big. Settings keys notify_email_to (default damien@terraflooring.com.au), notify_daily_on, notify_urgent_kinds (JSON, blank means defaults, [] means nothing urgent), notify_daily_sent_on, client_auto_sms_on. Loop guard: NOTIFY_FROM "Terra Ops <notifications@terraflooring.com.au>", subject tag "[Terra Ops]", isTerraOpsMail(from, subject).
- lib/notify.ts notifyOffice(kind, {title, body, jobId, data, path, forceEmail}): writes the alert, pushes to office phones, emails only urgent kinds (or forceEmail), stamps pushed and emailed_at. Never throws, never texts. Replies go to the email-to address.
- Every pushToOffice call now goes through notifyOffice: selection_done, quote_rework, quote_accepted, crew_on_site, client_text, variation_accepted, variation_declined, task_finished, ready_to_invoice, offer_expired, offer_accepted, offer_declined, handed_back, running_late, crew_note, quote_viewed. lib/reminders.ts still pushes on its own.
- New hooks: price check (one alert per invoice for new flags, specials never; over $50 is price_flag_big, else price_flag, path /finance/suppliers-owed; the price flag SMS is gone, PRICE_SMS_KEY kept but never read), statement missing invoices (missing_invoice), SWMS red card (swms_red, after the team@ email), Stripe card payment (payment_received, also on the overpaid path).
- 7am summary: buildDailySummary, dailySummaryText (today's jobs, overdue office tasks, crew tasks not finished in the last 60 days, overdue client invoices, open tasks, alerts not cleared in the last day). tickDailySummary sends once per Gold Coast day between 7am and noon, claims the day with an upsert (setWhere value != today) so two ticks never mail twice, and gives the day back if the send fails. Timer every 5 minutes, published server only; NOTIFY_DAILY=on/off overrides. ping shows timers.dailySummary.
- Loop guard: mail-agent queryFor adds -from:notifications@terraflooring.com.au and readOne skips Terra Ops mail ("Terra Ops' own email, ignored"). conversations.matchInboundEmail returns null for it. Matters because the agent reads damien@.
- Client auto SMS switch: sendMarketing step 0 refuses SMS when client_auto_sms_on is off and it is not a test ("client texts are switched off in Settings"). Conversation texts, variation texts, the voice late_client text and staff login texts are not affected.
- routes/alerts.ts: open, clear, clearAll (staffOnly; price_flag, price_flag_big and missing_invoice hidden from office without canSeeCosts), settings, saveSettings, previewSummary, sendSummaryNow (adminOnly).
- Web: Dashboard AlertsCard above Reminders (tick to clear, Clear all, link to the job or path, "emailed" mark). Settings tab Notifications (NotifySettingsCard: email to, daily on, preview, send now, urgent ticks by group, automatic texts to clients). Email agent tab lost the price flag mobile field (note in its place). queries/mail useSetPriceSms removed.
- Facts told to Damien: SMS last 90 days 18 out for about $1.50, 10 of them the price flag to ...555 ($1.11); ClickSend balance $16.20, number $20.90 a month. Live device_tokens is empty: no phone has registered for push (Android needs FCM credentials and a native rebuild, not done). No source yet for new work order, product arrived, or a client declining a quote online. Resend /domains gave 401, so the notifications@ sender is unconfirmed (same domain as team@). Mobile tap handler does not read data.path yet.
- Tests: fix1011/t-ntf.body.ts with t-i913.head.ts (PASS 109). Base DB now /tmp/ti7.base.db (ti6 plus alerts). run2 all pass incl. ntf. Stale fails unchanged (i6s send scope, i13 revise, w7 1, g15 4, lay 1). UI check fix1011/ntfui.py and ntfui-office.py: admin sees 7 alerts and clears one, settings save and reload, preview, office sees 3 with no cost alerts and gets Admin only on Settings, no page errors. Checks lint 0, api 0, app 138 (old), mobile 0, build 0.

### 18.35 Second sender: damien@ for the after-job care emails only (13 Oct)
Damien's request: care emails come from damien@ and replies go to his inbox. Quotes, invoices, bookings, reminders, swaps and every journey stay on team@.
- lib/senders.ts (no imports, the web reads it): SENDERS team ("Terra Flooring <team@terraflooring.com.au>", reply team@) and care ("Damien at Terra Flooring <damien@terraflooring.com.au>", reply damien@). senderFor(key) gives team@ for anything missing or unknown. MARKETING_FROM and MARKETING_REPLY_TO now read SENDERS.team (same values).
- sendMarketing takes sender?: SenderKey (email only) and passes from and replyTo to sendEmail. The journey engine passes none, so every journey stays team@. Nothing in the app names care yet; the care series build will.
- templates.sendTest takes sender (team or care, default team) and returns it. The template editor has a "From" picker next to "Send test to me", so Damien can see how a damien@ email lands in his own inbox. Still only ever to the signed-in staff member.
- Bug fixed on the way: sendMarketing wrote a sends row for the synthetic test contact (id -1), which broke the contact foreign key, so "Send test to me" gave a 500 on a test copy. A test to staff with no real contact now writes no sends row.
- DNS (read 13 Oct, not changed): resend._domainkey DKIM present, send.terraflooring.com.au CNAME to send.forge.rmta.net (Resend return path), root SPF via dc-412b9675f1._spfm (mlsend, google, sparkpost), DMARC p=none with Brevo reports, MX Google. Resend verifies the domain, so damien@ needs no new record. The key cannot read /domains (401), so Damien confirms the domain shows Verified in Resend.
- Replies to care emails land in damien@, which the mail agent reads. It only looks at mail with a PDF and invoice words and skips Terra's own documents, so a homeowner reply does not become a supplier invoice. No "replied" email event is recorded anywhere yet (journey branch "replied" is always no).
- Tests: fix1011/t-snd.body.ts with t-i913.head.ts (PASS 23): defaults, care from and reply, office allowed, crew and public refused, unknown sender 400 with nothing sent, sendMarketing default team@, no file but senders.ts names care or sends from damien@, journey engine has no sender pick. run2 all pass incl. snd. UI check fix1011/sndui.py: picker shows both, defaults to team, no page errors. Checks lint 0, api 0, app 138 (old), mobile 0, build 0.

### 18.36 Underlay upgrade offer on the material selection form (13 Oct)
Fix list 11 Oct, item 9. Go-ahead in answer 16. The form offers "Upgrade to <better underlay> for an extra $X inc GST?" with Yes, upgrade and No thanks.
- Reading of the deposit rule: the spec said Yes updates the quote total and the deposit, but answer 15 says after acceptance only variations, and Damien's variation rule is never its own invoice and never a new deposit. So Yes makes a variation, not a quote change. The quote stays locked.
- Settings, Business rules: UnderlayUpgradesCard (web/components/underlay-upgrades-card.tsx) sets pairs by product id. Stored as one JSON setting underlay_upgrades [{from,to}] (lib/underlay-pairs.ts, no imports, the web reads the key). One upgrade per quoted underlay. Each pair shows the extra per unit inc GST, or "Not offered" and why (not dearer, switched off, units do not match). The raw key is hidden from the extra settings list. routes/underlayUpgrades.ts get and save, adminOnly; save refuses non underlays, a pair to itself, and two upgrades for one underlay.
- lib/underlay-upgrade.ts: priceOffer(quoted, upgrade, qty, unit). Same unit and width keeps the metres. A different roll width, or lm against m2, goes through the floor area and wholeUnits. $X = new qty x upgrade sell minus quoted qty x quoted sell, ex GST, shown x 1.1. Cost difference goes on the variation line as unitCost.
- One row per offer in material_selection_items: offer_product_id (the upgrade) and answer ('' / yes / no). The price is fixed when the form is made. upgradeRowsFor runs in productItemsFor; a form made before the pairs gets its offers on Send again (addMissingUpgradeRows in createSelection). A quote with only underlay now gives a form that is just the offer; a form with nothing at all is still refused.
- Yes on a job where the client sees prices: its own variation, accepted on the spot with via "form" (approvalChannel form, approvedByName the typed name). Job value goes up, it goes on the final invoice, no invoice or deposit is made. applyAcceptedUpgrade moves the to order job_materials to the upgrade, scales the qty for a different roll width, and logs underlay_upgraded. An accepted Yes cannot be taken back from the form. If the accept fails, an office task "Underlay upgrade to check".
- Homeowners only (Damien, 13 Oct, replaces the first build's company billed draft path). companyBilled(jobId, quoteId) in lib/underlay-upgrade.ts: a company on the quote, or the job's billToType is company (builder, insurer, property manager). Then upgradeRowsFor makes no rows (so productItemsFor and Send again add none), publicOffers returns [] (guard for any older row), and applyUpgradeAnswers ignores every answer: no variation, no row change, materials stay as quoted. This holds even when the form's contact works at that company, so it is not the showPrices test. The public page no longer has a company field and the offer always has a price.
- No thanks: recorded on the row and logged. Nothing else changes.
- Public page (selection-products.tsx): UpgradeCard under the colour sections; the form needs an answer before it sends; settled shows "Upgraded to ...". Thank you text says where it went. Job page card shows the answer, price and the variation ref and status. The form email adds one line when there is an offer to answer.
- Schema: sql/2026-10-20-underlay-upgrade.sql (2 ADD COLUMNs). Applied live 13 Oct with Damien's OK by script, after backups/pre-underlay-upgrade.db (integrity ok). Live had 0 rows. No pairs are set live yet: Damien sets them in Settings.
- Tests: fix1011/t-upg.body.ts with t-i913.head.ts (PASS 145 after the homeowners only change; the old company billed draft version is t-upg.body.ts.bak-i9). Base DB now /tmp/ti9.base.db (ti7 plus the 2 columns), run2 uses it. run2 all pass incl. upg (i10 75, i8 136). UI check fix1011/upgui.py on a seed (t-upgseed.body.ts): Settings card adds a pair, public form needs an answer, Yes sends and shows Upgraded on reopen, builder page has no $, job card shows the approved variation, no page errors. Checks lint 0, api 0, app 138 (old), mobile 0, build 0.

### 18.37 Care series: after-job care emails to the homeowner (13 Oct)
- What it is: plain emails from Damien (second sender, 18.35) to the person living in the house after a job goes Completed. One timetable per floor type (codes and templates in lib/care-codes.ts, care-templates.ts, rendered by care-render.ts), plus the holiday emails (A1 to A5). Wool and loop carpet get their own C-W emails, so carpet jobs wait for a wool answer first. lib/care-plan.ts is pure: what is next, what is due, what has passed. lib/care-detect.ts reads the floors from the category, the job notes ("supply and install", "install only of", "to install", "to supply") and the price book fibre.
- Engine (lib/care-engine.ts, booted by lib/care-boot.ts): every 10 minutes on the published server only, and only when settings care_engine_on is on (Admin switch on the Care page). It is OFF on live until Damien switches it on. Series emails at 9am Brisbane, holiday emails at 7am, never more than one a day per person. On the first switch on, passOverAll marks every email whose date has gone as skipped ("before the series started, passed over"), so nobody gets a pile of old ones.
- Who gets it (homeownerFor, Damien 13 Oct): the person living in the house, never whoever pays. A job contact tagged Owner or Landlord comes first, one with an email winning. On company jobs (companyId, billToCompanyId or billToType company: builder, insurance, PM, agency, commercial) that is the only way in; the job client, the bill-to contact and the company's card people are never picked. Rentals: the Landlord tagged on the job, never the tenant or the PM. A Landlord who pays still counts unless they are on the company's card. A Tenant or Property manager tagged with no Owner or Landlord means nobody. On a plain homeowner job with no tags the job client is the homeowner, unless tagged builder, supervisor, PM, accounts or tenant.
- Trade (careTradeReason): contact marked trade, or on a company card of type builder, insurance_builder, property_manager, real_estate (treated as PM) or commercial. Retail is not trade. A contact marked homeowner is never trade. No job count rule: repeat homeowners still get it.
- No repeats: one series per person per floor type in any 12 months (FLOOR_RESTART_DAYS 365). The same floor restarts only when the new start is 365 days or more after the old one.
- Schema: sql/2026-10-21-care-series.sql (care_members, care_sends, care_templates and the jobs care columns, 15 statements). Routes routes/care.ts (report, member, setMemberStatus, setOn, runNow, setWoolRanges, templates, saveTemplate, resetTemplate, preview, sendTest, job, woolAnswer, setJob, retryJob). Web: pages/care.tsx (Marketing, Care emails: People, Emails, Wool ranges), components/care-card.tsx on the job page, price book fibre and pile editor in the variant modal (save on one colour or the whole range).
- Unsubscribe (lib/unsubscribe.ts, GET and POST /api/unsubscribe/...): signed links, one-click List-Unsubscribe-Post. The old marketing unsubscribe links never worked; they do now.
- Live, 13 Oct, with Damien's OK: backup backups/pre-care-apply.db (bad 0, integrity ok), dry run on a copy, then schema plus backfill by script. Backfill: completed jobs from the last 6 months (99, 41 company jobs), each person starting from today with past emails passed over. Before it, by Damien's word: a Siren Constructions company card (id 294, type builder) made and Nick Sherd linked, so his 3 jobs skip as trade. Result: 18 people in, 5 of them held as Taken out for Damien to check (business email domains: Anthony, Issac Genc, Justin, Robin Holt, Christine Moulder), so 13 active. 17 carpet jobs (15 people) wait on the wool answer. 63 skipped: 41 company jobs with nobody tagged, 11 floor not told, 4 works for a builder (Nick 3, Crystal Dawson of Fix A Tile 1), 4 no email, 3 marked trade (Matthew Campbell, Repair and Rebuild). 43 passed-over rows, 0 sent. Job ids 4226 and 4227 never touched. Engine still off.
- Follow-up, 13 Oct, Damien's form (backup backups/pre-care-holds.db, dry run, script): Robin Holt put back in. Anthony, Issac Genc (598), Justin and Christine Moulder stay out. Lou Cheevers taken out. Michael Milakovic, Charles, Issac Genc (second card 1651), Mike Johnson and Luke Staley were waiting on wool: their 5 jobs set to skipped and each given a stopped care_members row (floors []), so a later job cannot add them (enrolJob never restarts a stopped member). Reason on all: "Taken out by Damien (business email)". Live now: 13 active, 10 taken out, 12 jobs waiting on wool. To put anyone back, Damien uses the Care page (Taken out filter).
- Tests: care/t-pure.ts (PASS 615), care/t-care.body.ts with t-i913.head.ts (PASS 154, incl. Damien's rules and the rental block), run2 all pass but the known date related i16 PO line. UI check care/careui3.py on a copy of the dry run: Care page wool rows with client names, switch on text, job cards (wool, builder, added), fibre save on 16 colours, no page errors. Checks lint 0, api 0, app 138, mobile 0, build 0.

### 18.38 Lead sources, landing pages and timber repair pricing (14 Oct)
- What it is: every job now carries a lead source picked from a list Damien edits (Settings, Leads), and each landing page posts its form to Terra as well as to ServiceM8. A timber repair lead texts Marc the photos, his reply makes a draft quote at his price x the markup plus GST, and one tap from Damien sends it to the client. The landing pages themselves are not changed by this work; each keeps its own form and SM8 push. Terra never forwards to SM8.
- Names (lib/lead-codes.ts, no imports so the web uses it too): sourceName reads the old keys (repeat, referral, website...) as the new names. UNKNOWN_SOURCE "Unknown (before tracking)". REPORT_EXCLUDED_JOB_NUMBERS 4384, 4385, 4388, 4389 (the ZZTEST jobs). Repair types, floor types, the 3 quote templates, timberClientPrice (markup, minimum, GST, rounded to the dollar and nudged up when the quote cannot carry that exact dollar), readMarcReply.
- Schema: sql/2026-10-22-lead-sources.sql (22 statements): lead_sources (15 seeded, colon names like "Google Ads: Pharmacy"), landing_pages (6 seeded, form_key, client type, tags, timber flag), lead_submissions (every post, spam kept with its reason), ad_spend (per page per month), repair_requests (one per job, token hash, status new, asked, not_sent, see, priced, quoted, sent, accepted, offered), jobs tags, landing_page_id, gclid, utm, lead_flags, job_media tags, and the Timber repair skill.
- Form intake (lib/lead-intake.ts, POST /api/leads/<form key> in index.ts, CORS for *.terraflooring.com.au only): JSON, plain form or form with photos (10 photos, 15 MB each). FIELD_ALIASES reads each page's own field names; unknown fields go on the job under their own name. Spam: hidden trap fields, sent faster than a person could, more than 8 posts an hour from one address, links in the message. Spam never makes a job; Damien can let a blocked post through (Blocked form posts, Release). The same post again within 15 minutes is a duplicate and makes nothing. A good post: contact with the duplicate check on phone or email, a company card only when a business name is given, the site from Google Places (or a flag when there is only a suburb or the address is only in the message), job as Lead with the page's source and tags, office task "Call new lead", lead_new alert with push and an instant email. No SMS to Damien. The client thank you email is off unless switched on in Settings, Leads (lead_client_autoreply_on), and only goes when there is a valid email.
- Timber repairs (lib/timber-repair.ts, routes/timber.ts): a timber page lead texts the active installer with the Timber repair skill (Marc) a 14 day /r/<token> link. The photo page shows repair type, area, floor and suburb, and the photos full size; never the client's name, phone, email, street address or any price. His reply: a number is his price ex GST (the rest is his note), SEE makes an inspection task, anything else pushes the office (repair_bad_reply) and asks him again. 2 hour nudge when he has not answered. A price makes the draft quote from the template for the repair type and confirms back to him ("Got it, $350. Thanks Marc."). Under the auto send amount it goes straight to the client; otherwise repair_price_ready pushes the office with a link to /repairs/<id>. Client accepts: the dispatch is set to Timber repair with Marc's price as the pay and offered straight to him (sendDirectOffer, split out of routes/offers.ts). Marc never sees the client price, the markup or the margin.
- Screens: Settings, Leads tab (components/leads-settings.tsx): sources (rename moves the jobs), landing pages with the post URL to copy, client thank you switch, ad spend grid, blocked posts, timber settings (markup, minimum, auto send, 3 templates, price check, SMS cost per lead). Marketing, Leads report at /reports/leads (admin): leads, quotes sent, won, win rate, won value, paid, ad spend, cost per lead and won per $1 over the paid sources only, bar chart by source (click for its jobs), leads or wins over time by month or year, a Timber repairs tab per repair type. Pipeline, Timber repairs at /repairs and /repairs/<id> (staff): photos, client, Marc's price (only for someone who can see costs), client price, quote wording, Approve and send, Edit quote, Text Marc again, Set price (refused once the quote has gone). Public /r/<token>. Dashboard card: top 3 sources this month by won value (admin). Job page: source, tags, flags, Google click id and UTM, link to the timber repair. New job and New quote pick from the source list (LeadSourceSelect).
- Old jobs, Damien's word: the 17 "Commercial Kitchen Vinyl - LP V2.0" jobs go to Google Ads: Commercial Kitchen, 4382 to Medical & GP Clinic, 4386, 4387, 4396, 4406, 4407, 4419, 4442 to Timber Repairs, the ZZTEST jobs stay Unknown and out of the report, every other imported job is Unknown (before tracking), and the 11 Terra made jobs get their keys renamed. Not applied to live yet. Imported jobs all carry the import date (Sep 2026) until the fresh ServiceM8 export brings the real dates.
- Tests: leads/t-leads.body.ts with fix1011/t-i913.head.ts (PASS 175: every page's fields, spam, duplicates, release, Marc's replies, SEE, nudges, auto send, approve, accept and offer, report, drill, top 3, settings, client thank you), fix1011/t-ntf.body.ts updated for the new alert kinds (PASS 109), run2 all pass but the known date related i16 PO line, care/t-pure.ts PASS 615. UI check leads/leadsui.py on a scratch copy: Settings Leads tab, report and its Timber tab, repairs list and screen (desktop and phone), Set price check, /r/ good, run out and bad links, Dashboard card, job page lead line, no page errors and no long dashes. Checks lint 0, api 0, app 138, mobile 0, build 0.

### 18.39 Underlay follows the floor line's own qty (14 Oct)
- Bug: on quote 188006 the carpet was measured at 5 m2 (1.3 lm) and then typed up to 7 lm. The Renu underlay worked off the measure, so it said "1.3 lm of 4 m carpet x 2.19 = 2.9 lm".
- Fix (lib/quote-sizes.ts, floorFacts): the line's own qty wins. The measure only counts while the line's qty still matches what the measure gives. Typed over, carpet underlay is the line's lm x (carpet width / underlay width), and hard floor underlay is the line's m2 with no wastage note. Typing the carpet qty moves an underlay that was still on the old figure; an underlay typed by hand stays put.
- 7 lm x 4 / 1.83 is 15.3005, so the never rounded down rule gives 15.4 lm.
- Live scan 14 Oct: 3 underlay lines follow a floor. 188006 had already been typed to 15.33 by hand and was left. 4389 (draft) and 188003 (sent) were right. No data changed.
- Test: terra-scratch-tests/underlay/t-underlay.ts PASS 9. run2 all pass. Checks lint 0, api 0, app 138, mobile 0, build 0.

### 18.40 Job email thread: email from inside the job, replies filed on the job (14 Oct)
- Spec runable-job-email-thread-spec (15 Oct) with Damien's answers file. Web only. Admin and Office only (staffOnly); Crew never see job email. Nothing is sent until someone presses Send.
- Sending (lib/job-mail.ts, sendJobEmail): every job email goes through it, including Email quote (quote-email.ts), the variation send (variation-send.ts), the invoice send (invoice-email.ts) and the colour form (material-selection.ts). It sends from team@ as "Team Terra" (or the name the caller gives), puts " [#188042]" at the end of the subject (subjectWithRef in lib/conversations.ts, skipped when the tag is already there) and an X-Terra-Job header, threads under the last email on the job (In-Reply-To, References and Gmail threadId from the same mailbox), and logs the email with every file on the job thread and on each contact's History. Files over 18 MB in total go as 7 day download links (ATTACH_LIMIT_BYTES, LINK_DAYS). Device files are resized in the browser (canvas) and saved to the job file. Messages over 4 MB go to Gmail's upload endpoint.
- Senders (lib/gmail.ts): sendFromMailbox only allows team@ and damien@ (SENDING_MAILBOXES); billing@ is refused. damien@ is offered only to the login whose profile email is damien@, and only once damien@ is signed in with gmail.send. Until then the composer says it needs signing in again in Settings, Email agent. canSendFrom checks the live scopes, so the mail_accounts can_send flag alone is not enough.
- Composer (components/conversation.tsx, Email customer): To, From, CC (CcList), subject with "The job number goes on the end for you", Attachments (components/email-attachments.tsx: From job file multi-select incl. signed documents, From device). Email quote, Send variation and Email invoice got the same CC and Attachments sections and show which files went as links. Email invoice now attaches a client invoice PDF (lib/clientInvoicePdf.ts, pdf-lib, WinAnsi only) as well as the pay link.
- Inbound (lib/mail-replies.ts, fileReply and checkReplies, called from the mail agent pass on the published server): reads team@ and damien@. Match order: In-Reply-To or References header, then the Gmail thread in the same mailbox, then the X-Terra-Job header or the subject tag, then the sender's single open job (status not 8 or 9). No match: team@ mail goes to Unfiled, damien@ mail is ignored. Auto replies, bulk and newsletters, and no-reply senders never go to Unfiled; an out of office reply to a job email is logged with auto_reply set and no task. Supplier senders and invoice, statement or work order PDFs are skipped (left for the invoice agent). Mail from Terra's own mailboxes is skipped. Each filed client email makes an office task and notifyOffice("client_email") (new alert kind, 27 now). Every message looked at is kept in mail_replies so nothing is filed twice; each mailbox keeps its own place (replies_synced_through).
- Repairs: a repair job's email goes on the parent job's thread, labelled with the repair ref (messages.label).
- Filing (lib/mail-filing.ts, components/mail-filing.tsx): "Move to another job" on every email (moveMessageToJob moves the files too). Unfiled tray on the Dashboard (5, hidden when empty) and on Conversations: emails and texts Terra could not match, the sender's jobs as one tap chips, Another job (finder), New enquiry (makes a Lead job and files it there), Read it. Filing makes the task. Admin and Office only.
- Routes (routes/conversations.ts): senders, uploadSlot, send (cc, mediaIds, uploads), moveMessage, unfiled, fileUnfiled, newEnquiry. quoteSend, variations and clientInvoices accept cc, mediaIds and uploads and return linked.
- Schema: sql/2026-10-23-job-email.sql (messages mailbox, gmail_id, gmail_thread_id, label, auto_reply, two indexes, mail_accounts replies_synced_through, new mail_replies table). Not applied to live yet at the time of writing.
- To go live Damien must sign damien@ in again in Settings, Email agent, so Google gives send permission (team@ too if Settings asks).
- Tests: fix1011/t-jem.body.ts with t-i913.head.ts (PASS 141: senders, slots, composer send, tag and X-Terra-Job, Cc, attachments and links, History, threading, other job and crew refusals, damien@ send, billing@ refused, invoice PDF, every inbound rule, Unfiled, file, move, new enquiry, repair label, no sendAsTeam left in the 4 libs, no long dashes). t-ntf updated to 27 kinds (PASS 109). t-i8 now counts sends only, not the Message-ID read back (136). run2 all pass (i10 75, i8 136), leads PASS 175. UI check fix1011/jemui*.py on a scratch copy: Dashboard and Conversations tray, filing a seeded email from the tray (task made), composer with From, CC and job file picker, Move to another job finder, Email quote, Send variation and Email invoice dialogs, no page errors. Checks lint 0, api 0, app 138, mobile 0, build 0.

### 18.41 Job email: fixes after the first live run (14 Oct)
- Seen on live after the 18.40 publish: form confirmations (cognitoforms "Thank you for your submission") and a Telstra bill PDF landed in Unfiled; all mail from one builder (Zac at Ambrose, two sites) merged into one Unfiled item; a header reply into an Unfiled item was marked filed and made an office task with no job (task 10); a propertyme email showed a blank body; Unfiled offered no job for builders whose contact is not linked to the job.
- Junk rules (lib/mail-replies.ts, junkKind): bulk local parts now also notification(s), notify, alert(s), automated. Form and confirmation subjects ("thank you for your submission, enquiry, order", "we've received your") count as auto and never go to Unfiled. PAPERWORK_SUBJECT (bill, invoice, statement, remittance, receipt, account summary) with a PDF and no match is ignored and left for invoice reading.
- Ignore list: settings key mail_ignore_senders (JSON array of emails, ignoredSenders()). Checked after matching, so an ignored sender's tagged or threaded reply to a job email still files.
- Body: a whitespace only plain part falls back to the HTML part. stripHtml decodes numeric entities and trims spaces around line breaks.
- Unfiled grouping: unfiledFor(email, contactId, threadId, subject) joins an existing Unfiled item only on the same Gmail thread or the same base subject (baseSubject strips Re, Fw, Fwd). Otherwise a new item.
- Reply into an Unfiled item (conv state unassigned): no task, alert says "Email to file", mail_replies status "unfiled".
- Address match (lib/mail-filing.ts, jobsByAddress): open jobs (status not 8 or 9, not repairs) whose site number and street are written together in the subject or body ("248/42 Goldmine Road"; addressKey takes the first word straight after a number, skipping joining words such as "and"), max 3, from the latest 400 open jobs (95 on live at the time). Shown first in the tray with a map pin (byAddress), then the sender's own jobs.
- "Not a job" on each Unfiled item (dismissHolding, route conversations.dismissUnfiled, staffOnly): "Just this one" or "Ignore <email> from now on". The item's conversation goes to state closed (kept on record), its open tasks are marked done, and the sender is added to mail_ignore_senders if chosen.
- Live rows from the old rules (Unfiled convs 25 and 28, mixed conv 27, task 10 with no job) are not changed by this commit; they can be cleared with Not a job and the job buttons once published.
- Tests: t-jem PASS 178 (new section "live first run fixes (14 Oct)"). run2 all pass (i10 75, i8 136), leads 175. UI check fix1011/jemui6.py on a scratch copy: address button with map pin, Not a job with both choices, ignore saved and item closed, no page errors. Read only check of the address match against live Unfiled: Goodtown St item offers #188006 only, the Goldmine and Enderley item offers #4370 and #4428. Checks lint 0, api 0, app 138, mobile 0, build 0.

### 18.42 Supabase Disk IO warning: incremental backup sync (15 Oct)
- Supabase project Terra CRM (ref yozjpzkcbbvhjdyygetf) is on the Pro plan ($25 a month, Damien's screenshot 15 Oct) but its compute is still Nano (0.5 GB RAM, 2 MB work_mem, 5 MB/s and 250 IOPS baseline; metrics show 426 MB memory). An earlier note here wrongly said free plan. It warned that the Disk IO budget was running out.
- Cause, measured read only: Supabase's own postgres_exporter (role supabase_admin) runs a query over pg_stat_statements about once a minute. pg_stat_statements held 3,848 entries with 95 MB of query text, the longest 203,632 characters, almost all of them the old backup's one-off "insert into terra_backup_new ... values ($1 ... $30000)" statements (a new text each time a table's row count changed). On Nano every read of that text spills to temp files: about 200 MB written and read again each minute (3 temp files a minute, 10.7 GB in 73 minutes, 904 GB since the 29 Sep stats reset). The exporter's own queries are not in pg_stat_statements, which is why the top statements list did not show it. The full drop and rebuild of schema terra_backup every 6 hours added to it. App tables have no full scans: the only tables are terra_backup (no keys before this) and Supabase's own small system tables.
- Fix (lib/offsite-backup.ts, syncPostgres): terra_backup is kept and only new, changed and removed rows are sent. Every table now has its primary key (from the live table's single-column key, read with pragma_table_info). terra_backup._sync_tables holds one fingerprint per table and terra_backup._sync_rows one per row (sha1 of the row values). A run with nothing changed only reads _sync_tables. Upserts use one fixed statement per table (insert ... select from jsonb_populate_recordset($1) on conflict (key) do update), 500 rows or 1 MB a batch, so query stats stop growing and nothing spills on 2 MB work_mem. Deletes by key. New columns are added, removed columns dropped, and column types only widen (whole number, decimal, text). A table is rebuilt on its own when it is new, has no key, or its row count does not match live after the update. One transaction with the advisory lock and a 10 minute statement timeout, so a failed run leaves the last copy. Revoke and row level security are applied whenever a table is created. SUPABASE_BACKUP_FULL=1 forces a full rebuild.
- Storage: the database file is uploaded only when the data fingerprint (dataHash: every table, index and row) differs from database/latest.json. Otherwise only latest.json is rewritten with checkedAt (unchanged: true, same file and takenAt). offsite-backup-boot times the 6 hours from checkedAt, then takenAt. app-files/_manifest.json is written only when a file was copied. prune keeps the file latest.json points at. BackupInfo gained checkedAt, dataHash, unchanged and sync (counts are unchanged, so verify-offsite-backup still checks them). verify-offsite-backup also checks every table has a primary key once info.sync is set.
- Real runs from the sandbox on 14 Oct: first run (one time rebuild with keys) 116 tables, 18,625 rows, postgres ok, 181 s. Second run 17 s: live unchanged, no file uploaded, 0 rows sent, 0 rows inserted on Supabase. tools/verify-offsite-backup.ts VERIFIED. The published server still runs the old code (full rebuild every 6 hours) until Damien publishes; the first new run after an old one rebuilds once and is incremental from then on.
- Query stats cleared 14 Oct 20:53 UTC on Damien's go-ahead (select extensions.pg_stat_statements_reset(), 4,222 entries to 1). Watch for 3 minutes after: 0 temp files and 0 MB, against about 200 MB a minute before. Until Damien publishes, each old full rebuild adds new long insert texts again, so clear the stats once more after the publish if the warning comes back.
- Pricing (supabase.com docs, USD): Pro is $25 a month and includes $10 compute credit. On a paid plan Nano is billed the same as Micro (about $10), so the credit covers it and moving Nano to Micro costs nothing extra: 1 GB RAM, 11 MB/s, 500 IOPS. Supabase recommends the move but does not do it automatically. Small is about $15 (2 GB, 22 MB/s, 1,000 IOPS), about $5 a month more; Medium about $60. Under 2 minutes downtime to resize. Damien changes compute himself in Project Settings, Compute and Disk.
- Other facts: Storage bucket terra-backup is 728 MB (sandbox 561, app-files 104, database 46, files 17); Pro includes 100 GB. One video is over the 50 MB upload limit and is not copied (jobs/4230/area/1791905093106-ik1iwt-Video.mp4). 50 MB is the default global upload limit; on Pro it can be raised in Storage settings (the bucket has no limit of its own). After raising it, set SUPABASE_MAX_FILE_MB on the server and in the sandbox if the new limit is above 50 (code default 50). Until then tools/supabase-backup.ts stops on that video, so the sandbox schedule has not written a sandbox copy since 7 Oct (stopping on the video since 13 Oct). The sandbox schedule is 5c696ed4. The live app runs on Turso and Tigris and does not read Supabase.
- Test: terra-scratch-tests/fix1011/t-sync.ts on a local Postgres 17 with a /tmp copy of live (PASS 38: first run from the old keyless shape, quiet second run, edits, deletes, new and dropped tables, added and renamed columns, type widening, count repair, rollback on failure, forced full rebuild, no new stats entries for a different number of rows, storage skip and heartbeat). Checks lint 0, api 0, app 138, mobile 0, build 0.

### 18.43 Delete products from Settings, Price list (15 Oct)
- Damien's ask: a bin at the end of each row, tick boxes with Delete selected (filter by supplier or range, select all, delete), delete separate from Active, only products never used can go, used ones are hidden (Active unticked) with the reason, bulk shows the counts and asks to confirm, Admin only, every delete logged (who, when, which product), and Undo last delete like Undo last import.
- Used means any of: quote_items, quote_price_history, job_materials, variation_items, purchase_order_lines, price_flags (supplier invoices), installer_account_entries, or material_selection_items through product_id, quoted_product_id or offer_product_id (lib/product-delete.ts, productUsage; price-import's productsInUse now uses it too). The reason reads like "Used on 2 quotes and 1 job."
- My calls (not asked): a product in an underlay upgrade pair (setting underlay_upgrades) is kept as it is, reason "take it out of the pair first". At most 1,500 a delete (MAX_DELETE). The selection clears when the search or Show discontinued changes, so nothing off screen is deleted. A used product that is already hidden stays as it is.
- Flow: the bin and Delete selected both open DeleteConfirmModal (productDelete.preview): to delete count, an amber "will be hidden instead" box, "Not deleted, and why" list, and the list to be deleted; the button says "Delete N products" or "Hide N products instead". productDelete.apply re-checks usage inside the delete statement (UNUSED_GUARD), so a product used in the meantime is hidden instead and the log row is corrected. product_specials and voice_phrase_product_matches go with the product (cascade); a JSON snapshot of the product and both lists is kept for undo.
- Log: tables product_deletes (who, when, counts, undo state) and product_delete_rows (product id, action delete, hide, kept or refused, name, reason, was_active, snapshot). Activity log per product (product_deleted, product_discontinued, product_delete_refused, product_restored, product_reactivated) and per delete (entityType product_delete: products_deleted, products_delete_undone). Delete log button shows the last 20; click one to see its products.
- Undo last delete (productDelete.undoLast): newest delete not yet undone. Puts each product back with the same id, prices, specials and voice matches, and ticks Active again on the ones this delete hid. Skips a product someone re-ticked by hand and a product whose variantKey is now taken by a new row, and says so.
- Admin only: routes are adminOnly; the checkbox column, bulk bar, bins and tools render only for Admin. Office and Crew cannot open Settings at all (checked: Office sees "Admin only").
- Schema: packages/web/src/api/database/sql/2026-10-24-product-deletes.sql (two tables and index product_delete_rows_delete_idx). Applied to live 15 Oct on Damien's OK (backup terra-live-pre-product-delete-2026-10-15.db, dry run clean, 3 statements in one batch, both tables empty, products still 4,485). It must be on any database before this code runs, or the delete buttons error.
- Tests: terra-scratch-tests/fix1011/t-pdel (PASS 80): Office, Crew and signed out refused; preview counts and the over 1,500 refusal; bulk apply; specials and voice matches removed; used hidden, paired kept, log rows; single used, already hidden and paired refused with the reason; undo newest first with exact restore, hand tick and variantKey clash respected; selection offer counts as used. Whole Dunlop supplier (402): preview 24 ms, apply 400 deleted and 2 hidden in 74 ms, undo 400 back in 104 ms, rows identical. Regression pairs on a new base (live copy of 15 Oct): same results on main and on this branch (the failing checks in imp, i16, ntf, care, leads and jem depend on the older base's data, e.g. Dunlop already imported on live). UI check fix1011/pdelui.py on a scratch copy (trimmed to 896 products, since 4,485 rows took the sandbox Chrome to 1.3 GB): bins and ticks for Admin, select all after a Dunlop search, confirm shows 400 and 2, delete, notice, filter change clears the selection, single used product offers "Hide 1 product instead", Delete log with rows, Undo puts 402 back, no page errors.

### 18.44 Phone app: office pages for Admin and Office logins (16 Oct)
- Damien's ask: Admin and Office logins on the phone get a cut-down office menu. Crew keep the installer view unchanged. Shown on the phone: Dashboard, Conversations, Quotes, Voice drafts, Jobs, Schedule Board (view only), Crew map, Clients, Companies, Supervisors, Invoices (/finance/invoices), Callbacks (/finance/callbacks), Terra AI. Everything else is website only (Timber repairs, Referrers, SWMS and SDS, SWMS library, other Finance, Suppliers, Marketing, /reports/leads, all Admin). Quoting on the phone picks price book products but cannot change prices. Nothing changes on the website.
- Damien's form answers: show the website's own pages inside the app with the cut-down menu (one new store build, then updates go out with website publishes); office Me shows name, email, hands-free and Sign out; "Yes, build it".
- Before this, the live admin and office logins have no installer card, so whoami gave canSeeOffice true and canSeeField false: only the Office and Me tabs, landing on /office. Office was a native stats screen (On today, Not covered, Open jobs and leads, Last 30 days, On site now, Today's run, Needs covering, Offers out, Running late, Latest activity). Me was installer only and loaded blank.
- My call: the phone menu is the phone list intersected with what the role already sees on the website. Office does not get Invoices, Callbacks or Terra AI (they are in ADMIN_ONLY_PATHS and show "Admin only"). Office was not widened.
- Detection (web/lib/phone-app.ts, isPhoneApp): window.__TERRA_PHONE_APP__, or ?app=1 (kept in sessionStorage terra-ops.phone-app, ?app=0 clears it), or a user agent with TerraOpsApp/. In phone mode lib/api.ts sends the header x-terra-app: phone.
- Server price lock (api/lib/phone-app.ts, fromPhoneApp; routes/quotes.ts): with the phone header, addItem with a unitPrice other than 0 or any unitCost, and updateItem that changes unitPrice, unitCost or markupPercent, are refused (FORBIDDEN, "Prices are changed on the website, not in the phone app."). addProduct and changeProduct still work. The quote agent passes the headers through, so Terra AI price edits from the phone are refused too.
- Quote builder in phone mode: sell, cost and markup inputs disabled; subtitle "Prices come off the price book. Changing a price is done on the website."; Add line replaced by a note that lines not on the price book, and price changes, are done on the website.
- Schedule Board in phone mode: no dragging, no extend handles, no command box, installer name not a link to /team, phone subtitle and footnote. Tapping a bar opens BookingView, a read-only sheet (Job, Customer, Site, When, Arrive, Installer, Status, Offers, Open the job) in place of the book and dispatch panels.
- Layout (components/layout.tsx): PHONE_PATHS, PHONE_BLOCKED_PATHS (/companies/types), phoneCanOpen and phoneNav. navFor filters the role's menu in phone mode. A page outside the list shows "Website only" with a link back to the dashboard (checked before the office "Admin only" check). Sign out is hidden in phone mode (it lives on the native Me tab).
- Mobile: react-native-webview 13.16.1 (bunx expo install). The Office tab (app/(tabs)/office.tsx) is now a WebView of the site with ?app=1 and user agent TerraOpsApp/1. Before the page loads it checks the origin, sets __TERRA_PHONE_APP__ and writes the session token (lib/auth.ts, sessionTokenForWebPages: managed token, else web token, else the session cookie) to localStorage runable.managed-auth.token. Header: Back, Reload, Voice quote. Android back goes back in the WebView, pull to refresh, "Opening the office" while loading, "Could not reach the office" with Try again. Links off the site open outside the app. path and at params open a page inside the WebView. The old native office stats screen is gone (the website Dashboard replaces it). Crew lock screen kept for non-office logins.
- Voice quote: "Open the quote" now opens /quotes/<id> inside the Office tab on the phone (web build still opens a browser tab).
- Me tab: office logins (canSeeOffice and not canSeeField) get OfficeMe (initials, name, email, Admin login or Office login, hands-free card, Sign out, build line). Crew get the old screen unchanged. HandsFreeCard office shows an info card: Siri, CarPlay and arrive by location run on a crew login only; use Voice quote.
- Release: WebView is native code, so this needs a new store build (iOS and Android) after the website is published. It cannot go out as an OTA update.
- Tests: terra-scratch-tests/fix1015/t-ph (PASS 25): with the phone header for Admin and Office, addProduct, quantity change and same price update work; price, cost and markup changes and priced or costed hand lines give 403 with the website message and the price is kept; without the header both still work. UI check fix1015/phui.py at 390x844 with ?app=1 on a scratch copy: Admin menu is exactly the 13 items with no Sign out; settings, products, cashflow, repairs, safety, swms-library, companies/types, referrers, team, review, marketing/care, reports/leads, suppliers and expenses show Website only; shown pages and job, company and quote details open; Office menu is the same less Invoices, Callbacks and Terra AI (those show Admin only); schedule read only with BookingView and no inputs; quote price inputs disabled with the note and product search; no page errors. Website at 1440 without the flag: full menu, Sign out, dragging, command box and Add line all as before. The WebView itself was checked by mobile tsc only (no device here). Checks lint 0, api 0, app 138, mobile 0, build 0.

### 18.45 A voice quote always makes a job (16 Oct)
- Damien's ask: a voice quote with no job in play makes a new job with the next number, at Lead, and the draft quote goes in that job with the same number. Quotes never exist without a job. Fix quote Q188008 by making its job and linking the quote.
- Why Q188008 had no job: buildQuoteFromTranscript (routes/voiceQuotes.ts) only used link.jobId, and section 18.9 left voice drafts without a job. It was the only quote on live with no job.
- Damien's form answers: "Yes, build it". Source on a job made by a voice quote is "Unknown" (he sets the real one himself, because Where it came from feeds the leads report). Site for job 188008 is the one on file, 58 Finnegan Cct, Oxley (site 3030). If a client name in a memo matches more than one client, ask, don't guess. On the live fix OK: set the job value to the quote total, make jobs made this way take their value from the quote, and keep it updated when the quote changes.
- lib/lead-codes.ts: UNSET_SOURCE = "Unknown". Not on the Settings list, so it shows as its own line in the leads report (sourceName keeps it, the legacy key is lowercase unknown) and LeadSourceSelect shows it as the current value.
- Voice quote (buildQuoteFromTranscript): with no job, createJobForQuote makes the job straight after the quote insert (same number, first active status Lead, customer, bill to, Owner row, source Unknown). If that fails the quote is deleted and the error reads "The job for this quote could not be made, so no quote was saved." Logs "Job #N made with voice quote REF" (entity job) and the created_from_voice row now carries the job. The capture gets jobId. Returns jobId and madeJob. Two companies with the spoken name are no longer guessed (limit 2, attach only when exactly one).
- Quotes (createQuoteRecord): a quote with no job always makes one now, not only with makeJob, source input.source or Unknown. quotes.update already refuses a jobId that is not the quote's own job (so it cannot be set to null). moveMade in memos no longer takes a quote off its job.
- Memos: a quote action that made a job sets memo.newJobId, its label reads "Job #N and quote REF drafted, ...", and the capture gets jobId. runActions runs create_job first, then quotes, then the rest, so an email or note in the same memo lands on the new job. A redo deletes the draft and puts the new one back on the same job as version 1 (newJobId is carried). repointNewJob: when the client is changed on a memo that made a job, the job's customer, bill to and Owner row follow (skipped once it has an invoice or a different customer set by hand).
- Name clash (lib/memo-context.ts): wordScore, nameFits (every spoken word fits the client), Candidate.nameFits and byId (phone, email or job number), nameClash(pick, list). routeMemo turns existing into unsure when the pick clashes; strongMatch (lib/quote-customer.ts) returns null, so the voice quote page leaves the customer for Damien to pick. A mobile or email said settles it. "Mohammed Arshad" fits Muhammad Arshad and not Iftiaz Mohammed, so no clash there.
- Job value (lib/job-value.ts, syncJobValue and syncJobValueFromQuote): a job made by its quote shows the current quote's total as its value and the quote's deposit split as its deposit. Current quote: the newest version still draft, needs review or sent. Runs from recalc (every total change), quotes.update when the deposit or status changes, decline and remove. Only while no quote on the job is accepted (quote-accept.ts owns the value from then on) and only when the job was made for its quote (its first quote is no newer than the job, to the second). A job made by hand and quoted later keeps the value typed on it. Read only check of live: no existing job's value would change.
- Live fix 16 Oct on Damien's OK (backup /home/user/backups/pre-188008-job-1016.db, 118 tables, 0 bad, integrity ok; dry run on a copy; one batch plus the capture update): job 4234, number 188008, Lead, title 58 Finnegan Cct, site 3030, customer and bill to Muhammad Arshad (983), source Unknown, value 0 and deposit 0 (the quote total is 0, no lines yet, and it follows the quote once this code is published). Owner row on the job (primary, on site, SMS, email, approves, shown to crew). Quote 21 job 4234 and site 3030. Capture 26 job 4234, memo newJobId 4234 with the new label and job label. Activity 2311 on the job, new activity "Job #188008 made for voice quote Q188008". Job counter left at 188008 (next job 188009). Quotes with no job on live: 0.
- Tests: terra-scratch-tests/fix1016/t-vq.ts (PASS 81, AI, S3 and job creation faked with bun mock.module): voice quote with no job (number, version 1, Lead, Unknown, customer and bill to, value, Owner row, capture, both log rows, counter once); on a job (version 2, no job); forced job failure (500, no quote left, capture failed); memo quote (newJobId, label, email draft on the new job, redo on the same job as version 1, client change moves the job, Owner row and quote); two clients with one name (memo unsure, quote waiting, strongMatch null, picking one makes job and quote, voice quote page not guessed, mobile picks the right one, twin companies not guessed); Mohammed Arshad no clash; createQuoteRecord with no job makes one, quote cannot be detached; job value follows the newest version, a new line and a deposit change, not an older version, falls back after a decline, hand made job keeps its value, Quotes page job takes and follows the total. fix1015/t-ph PASS 25.
- Checks: lint 0, api 0, app 138 (baseline), mobile 0, build 0.

### 18.46 Copy from previous job and Duplicate this quote (16 Oct)
- Damien's ask: a "Copy from previous job" button on New quote, and "Duplicate this quote" on a quote, a job and the client record. Search by client name, site address, product or quote number, the picked client's quotes first. Each hit shows client, address, date, ref, main products and total m2. Every line has a tick, all ticked except site prep (self-leveller, moisture barrier, primer, furniture moving, stairs, uplift and disposal). Site notes, photos, SWMS, access notes and job dates are never copied. Admin and Office.
- Damien's form answers: every line is priced off today's price book (an ended special goes back to standard), a discontinued or missing product is red and must be replaced or unticked, labour is worked out again off today's rates, hand lines keep their old price and are flagged. Freight, baling and the other supplier charges follow the usual rule (rebuilt by recalc, their own 15% line folded in), pallets counted again. Every m2, lm and labour line says Check required (yellow) and the quote cannot go out until each is confirmed or edited. Same client: a new job at Lead with a new number, same client and site, source "Repeat client" (lead_sources id 9), no access notes, label "Follow-on from Q...". Another client: products and quantities only, saved with no client and no job; the job is made when the client is picked, source Unknown; label "Copied from Q...". A company client gets no underlay upgrade offer (companyBilled already does this). The original quote and job are never changed. "Copied from Q..." on the new quote, "Copied to Q..." on the original job, copies grouped on the client record. DB OK: "Yes, back up and add them".
- Schema: products.site_prep, labour_rate_items.site_prep, quotes.copied_from_quote_id (no FK), quote_items.check_required. SQL in database/sql/2026-10-25-quote-copy.sql. Settings Price list and Labour rates (edit mode) have a Site prep tick (adminOnly productUpdate and itemUpdate take sitePrep).
- lib/quote-copy.ts: copySearch (newest version of each number, quotes with real lines only, picked client first, then a ref match, then newest), copyPreview (ticked, sitePrep, missing, canReplace, newUnitPrice, checkRequired, keepsOldPrice, linkedTo), copyCreate (checks every line before writing, reprices products with liveSellFor, qty off the measured m2 again on today's product but never below the old qty on the same product so a hand bumped carpet cut is kept, labour with standardLabour and install qty off the copied floor (never below the old install qty unless the floor was swapped), links installs and underlay to their copied floor and refollows underlay, recalc rebuilds the supplier charges, two activity rows copied_from and copied_to), quotesForClient (copies under the root original; a company record also takes quotes on the company's jobs when the quote itself only names the contact). lib/quote-copy-links.ts: copyLinksFor (quotes.get returns copiedFrom and copies) and copyLinksForJob. routes/quoteCopy.ts: search, preview, create, forJob, forClient, all staffOnly. A copy is priced at the price book, so the discount is 0 and Office stays inside its usual limits.
- Quotes: createQuoteRecord takes waitForClient (no job yet, only for an other client copy) and noAccessNotes. setCustomer makes the job when the quote has none (Unknown, no access notes for a copy) and returns jobId. updateItem takes checkRequired false (Confirm); editing qty, measured m2, wastage, roll width, price, product, description or markup clears it, and Change product clears it. assertReadyToGoOut refuses while any line says Check required, and refuses a quote with no client. New version carries copiedFromQuoteId and each line's checkRequired.
- Web: components/quote-copy.tsx (QuoteCopyModal with search, tick list, red lines with a replacement picker, same client or another client; DuplicateQuoteButton; JobCopyLinks; ClientQuotesCard). New quote has the Copy from previous job button. Quote builder: Duplicate this quote, yellow Check required rows with Confirm, Follow-on from or Copied from link, Copied to list, and a count of lines still to check. Job Quotes card: Duplicate per quote and the copy links. Contact record Quotes card and a new company Quotes card group the copies.
- Only 10 jobs on live have quote lines to copy from. Old ServiceM8 jobs have none.
- Tests: terra-scratch-tests/fix1016b/t-cp (PASS 171): search order and fields, preview ticks and site prep, red product and replacement, repricing, labour off today's rate, install and underlay qty (a floor or an install never drops below its old qty unless the floor was swapped), hand line price, hand line price, supplier charges rebuilt, Check required and the send block, Confirm and edit clear it, same client job at Lead with Repeat client and no access notes, other client no job until setCustomer (Unknown), links both ways, original untouched, company copy has no upgrade offer, company card via the job, Office can copy and keeps its price limit, a field login is refused. fix1016/t-vq PASS 81, fix1015/t-ph PASS 25. UI check on a scratch copy (port 4299): copy from the search list, yellow rows and Confirm, Mark as sent blocked, Follow-on from and Copied to links, job Quotes card, contact and company Quotes cards, no page errors. Checks lint 0, api 0, app 138, mobile 0, build 0.
- Live, 16 Oct, with Damien's OK: backup backups/pre-quote-copy-1016.db (118 tables, 18980 rows, bad 0, integrity ok), dry run on a copy, then fix1016b/apply-cols.ts with APPLY=1: 4 columns added (quotes.copied_from_quote_id, quote_items.check_required, labour_rate_items.site_prep, products.site_prep), 50 rate items and 4 products ticked Site prep. Read back confirmed. Only 11 jobs on live have quote lines to copy from (10 plus test job 188000); old ServiceM8 jobs have none.

### 18.47 Referral fees (16 Oct)
- Damien's ask (attachments/runable-referral-fees-spec): a builder or company that sends Terra a client and asks for a cut, paid only when the job is paid in full. Damien's form answers override the spec where they differ.
- Damien's answers: each referrer card has a default rate. An Admin can set any %, a fixed $ amount or 0 on one job, and the draft quotes recalculate. Sent and accepted quotes never change; a new rate only reaches a re-quote. The fee is ex GST and on top: $10,000 at 5% is $500, the client pays $10,500 plus GST, Terra's margin is unchanged. The client copy spreads the fee over the lines pro rata. The Admin's internal view shows it as its own line. No footer line, ever. Blocked, with a plain reason, when the referrer is the bill-to, the client or the company on the job. Variations and re-quotes recalculate. Paid in full means every invoice paid, a final among them, nothing owing. Then an Admin only task "Pay Fix A Tile $500 referral fee for job 188xxx" and a Referrers owed entry, where he attaches their invoice (with GST if registered) and marks it paid with a date. Cancelled or closed and not paid in full: flagged for him to decide. Never netted off, nothing paid or sent automatically. Fee tasks and Referrers owed are Admin only; Office never sees the fee, the rate or the bank details, but Office can pick the referrer. Live DB OK given.
- Schema (database/sql/2026-10-26-referral-fees.sql): office_tasks.admin_only, and three tables kept apart from companies, contacts and jobs so a rate or bank account can never ride along in a row Office reads. referrers (one per company or contact: active, rate_percent, abn, gst_registered, bank_account_name, bank_bsb, bank_account_number, remittance_email). job_referrals (one per job: referrer, fee_type default, percent or fixed, fee_value, status open, owed, flagged, paid or no_fee, amount, flag_reason, task_id, invoice_key, invoice_name, invoice_amount, paid_on, paid_by_name, decided_by_name). referral_snapshots (one per quote or variation: referrer, name, fee_type, fee_value, base, amount, blocked_reason).
- lib/referral-fees.ts: rateOf (job rate or the card default), feeAmount (a fixed fee goes on the quote only, never a variation), blockReason, feeOnQuoteRecalc and feeOnVariationRecalc (called by recalc in routes/quotes.ts and recalcVariation in lib/variations.ts with the line sum ex GST; write the snapshot and return the fee added on top of the subtotal; a locked quote keeps its snapshot; a sent quote keeps the rate it went out with and only its lines move the fee; a draft takes the job's current referrer and rate), paidInFull, feeDueOn (accepted quote's fee plus each approved or invoiced variation's), acceptedRates (the rate the fee was worked at, for Referrers owed and the card), checkReferral (open to owed, flagged or no_fee; never throws into a payment), markOwed (Admin only task, updated in place if one exists, never a second), sweepReferrals, decideReferral, referralOnCancel, feesWaiting. lib/referral-fold.ts: foldFee spreads the fee over every line by price to the cent (run after the supplier charge fold), priceWithoutFee. lib/referral-quote-view.ts: feeForStaff, feeLinesForStaff, typedPriceWithoutFee.
- Where it shows: quotes.get gives an Admin the lines as they are plus referralFee ("Referral fee: Fix A Tile, 5%, $500.00") and the margin worked on the price before the fee. Everyone else gets the lines with the fee spread in and referralFee null. The same for variations (viewOf). quoteBundles clientLines (client copy, PDF, public page) folds the fee in. A price typed by a non-Admin on a quote or variation line is taken back out of the fee (and the supplier charge fold without costs), so it never compounds. quoteAgent.apply goes through updateItem as the actor, so it is covered.
- Paid in full: markInvoicePaid calls checkReferral when an invoice becomes fully paid. cancelJob calls referralOnCancel (a test clear takes the referral off unless paid). Referrers owed and the 7am summary sweep every open referral first, so a payment that came in another way still counts.
- Admin only tasks: officeTasks.open, complete and snooze hide them from non-Admins. The 7am summary leaves them out of the task list and adds a REFERRAL FEES line ("Referral fees waiting to be paid: N", the amount only when every address it goes to is an Admin's, and "Referral fees for you to decide: N"); it never names the referrer. Cancel preview leaves them out. Reminders push them to Admin profiles only.
- routes/referrals.ts: card, saveCard (BSB 6 numbers, account 4 to 12, email checked; a new default rate or the tick off recalculates draft quotes on open jobs), owed, attachInvoice (PDF, PNG or JPG to S3 referral-invoices/), markPaid (closes the task), unmarkPaid, decide, report (date range on the job's created date) are adminOnly. pickList (names only), forJob (Office gets the name and locked; an Admin also gets rate, fee, status, block and flag reasons) and setForJob (Office picks who; only an Admin sends feeType or feeValue) are staffOnly. The job activity logs "Referrer set to Fix A Tile", the name only.
- Web: components/referrals.tsx (ReferrerSection on company and contact cards, Admin only: the "Also a referrer" tick and fields, both sides, referred jobs; JobReferrerCard on the job above Supervisor, shown when the source is Referral or a referrer is set; ReferralFeeRows in the quote builder totals; the fee row in the variation lines table). pages/referrers-owed.tsx (Finance, Referrers owed, Admin only: To decide, To pay, Paid; attach invoice, Mark paid with date and invoice amount, Pay this fee or No fee, Undo paid). Referrers page has an Admin only "Referral fees" tab. Clients and Companies lists have a Referred column and sort (intel routes are adminOnly already).
- Known and kept: Office with the cost switch on sees a margin that includes the fee (its lines carry it). Consistent, and it doesn't reveal the fee.
- Tests: terra-scratch-tests/fix1016c/t-rf (PASS 140, scratch copy with the new SQL): the 4 spec tests (Fix A Tile at 5%; $10,000 is $10,500 plus GST, spread 300 and 200 into the lines on Office's view and the client copy; paid in full makes the Admin only task and the owed entry; billed to Fix A Tile is blocked with the plain reason), company on the job blocked, fixed $300, 0%, over 100% refused, Office re-pick keeps the Admin's job rate, Office cannot set a rate or read the card, owed, report or intel, nothing secret in Office's quote, forJob or variation, price take-back for Office with and without costs and on a variation, sent quote unchanged by a new card rate, re-quote takes it, variation fee at the job rate, accepted quote and variation never move, part paid stays open, task hidden from Office (list, complete, snooze, cancel preview, 7am list), the 7am line, attach (text refused), mark paid, undo, pay twice refused, referrer locked once settled, cancelled job flagged with no task, decide owe 200 then 250 (one task), no fee closes it, report range, Referred value, card both sides and the worked rate. fix1016b/t-cp PASS 171, fix1016/t-vq PASS 81, fix1015/t-ph PASS 25. UI check on a scratch copy (port 4299): Admin card, job card, quote totals line, Referrers owed, Referral fees tab, Referred column; Office sees the name only, no Also a referrer, no fee on the quote, no Referrers owed or Referral fees tab; Office picks Fix A Tile on a Referral job, Admin sets a fixed $250 and the draft quote moves by $250; no page errors.
- Checks: lint 0, api 0, app 138 (baseline), mobile 0, build 0.
- Live, 16 Oct, with Damien's OK: backup backups/pre-referral-fees.db (118 tables, 19194 rows, bad 0, integrity ok), dry run on a copy, then fix1016c/apply-ref.ts with APPLY=1: 5 statements run, tables job_referrals, referral_snapshots and referrers added, office_tasks.admin_only added. Read back: tasks 14 (admin only 0), quotes 12, jobs 4236, referrers 0, job referrals 0, snapshots 0. No referrer is set up on live yet; Damien adds them from the company or contact card.

### 18.50 Phone app: office pages fit the phone (16 Oct)
- Damien's ask: inside the phone app, no pinch zoom and every page fits the phone width with no sideways scroll; Jobs, Quotes, Clients, Invoices and Conversations as stacked cards (number, customer, site, status, tap to open); Dashboard one column with Alerts and Unfiled near the top; one header (the app's "The office" bar with the menu in it); Schedule one day at a time with swipe; finger sized buttons and rows (44px). Only inside the app. The website on a computer is unchanged. Numbered 18.50 because 18.48 (Job merge) and 18.49 (Builder POs) were already taken by work in progress.
- web/lib/phone-app.ts: hasAppMenu (isPhoneApp and window.__TERRA_APP_MENU__, set only by app build 12 on). applyPhoneChrome runs at load in phone mode: adds the phone-app class (and phone-app-menu) to html, sets the viewport to width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, and blocks gesturestart and gesturechange.
- styles.css html.phone-app block: no sideways overflow on html, body and main; inputs, selects and textareas 16px (stops iOS zooming on focus) and 44px high; [data-slot=button] 44px high, icon buttons 44px wide; other buttons 36px; checkboxes 20px; long text wraps (overflow-wrap break-word); grid children min-width 0; a table not yet made into cards scrolls inside its own card.
- Layout: with hasAppMenu the website's sticky Terra Ops bar is left off and window.__terraOpenMenu toggles the menu drawer. An older app build (no flag) keeps the website bar, so nothing breaks before build 12. Page uses tighter padding in phone mode and puts the page actions two to a row, full width.
- Dashboard (pages/index.tsx): the 2140px wide page was a grid blowout from long unbroken text in the right column; fixed with grid-cols-1 and min-w-0. In phone mode: stats two to a row, then Alerts and Unfiled, then one card under another.
- components/phone-card-list.tsx (PhoneCardList): one card per row, 64px high, whole card is the tap. Used in phone mode by Jobs (number, status, customer, site, title and value), Quotes (ref and job, status, customer, site, total and valid to), Clients (name, owing, mobile or email, suburb, revenue and jobs), Companies (name, owing, type and people, revenue and jobs) and Invoices (number and job, overdue or status, who, kind and due, total and owing). Supervisors already stacked below md. Conversations already stacked; in phone mode it has tighter padding, Unfiled shows 3 and the filter button is 40px.
- Schedule (pages/schedule.tsx, PhoneDay): one day at a time, by installer, opened on today. Arrows and a sideways swipe (over 60px and mostly sideways, so scrolling never flips the day) step a day, rolling into the next or last week; Back to today. Each installer with work that day is a card with their jobs (title, ref, suburb, time, Day n of m, 2 man, done or on site), Double booked when two live jobs share the day. Free this day lists the rest; Unassigned below. Tap opens the read only BookingView. The week grid stays on the website.
- Mobile (app/(tabs)/office.tsx): boot script also sets __TERRA_APP_MENU__; a menu button left of "The office" calls __terraOpenMenu; header buttons are 44pt; WebView scalesPageToFit false, built in and display zoom controls off, textZoom 100. Native change, so it needs app build 12 (no OTA).
- UI check on a scratch copy (port 4299) at 390x844 with the phone flags: Dashboard, Jobs, a job page, Schedule, Quotes, Clients, Invoices, Conversations, Crew map, Companies, Supervisors, Voice drafts and Callbacks all 390 wide (Dashboard was 2140). Swipe right went Fri to Thu, the arrows to Tue 13 Oct with Damo's booking. The menu opens from __terraOpenMenu. Without the menu flag the Terra Ops bar is still there. Website at 1400 without the flag: three column dashboard, Jobs table and week grid as before, no phone-app class. No page errors.

### 18.51 No public sign-up (16 Oct)
Damien makes every login himself in Admin, People. Staff are invited. Nobody can make their own account.
- Sign in page (pages/login.tsx): sign in only. "No account yet? Create one", the name field and the "first account becomes the admin" line are gone. It now says "No login yet? Ask the office to add you." The password hint reads "Your password". The phone app's own sign in screen never had a create link; its Office tab shows this same web page.
- Server (api/auth.ts): emailAndPassword disableSignUp, so /api/auth/sign-up/email answers EMAIL_PASSWORD_SIGN_UP_DISABLED. A databaseHooks user.create.before hook refuses any new login made through Better Auth (that is how Continue with Google made one for any Google account) once the database has a profile. Add person (routes/team.ts) writes its rows itself, so it is not affected. The Play reviewer login already exists and is unchanged.
- Middleware (api/middleware/auth.ts): a login with no profile used to get one as Field crew with an installer card. Now it gets FORBIDDEN "There is no Terra Ops login for this account. Ask the office to add you." Only a brand new empty database still makes its first login the admin.
- Website (components/layout.tsx): that FORBIDDEN shows a "No access" card with Sign out, not the board.
- Continue with Google is hidden, on the web sign in page and on the phone app's sign in screen (with its "or" divider), because everyone signs in with email and password. The server side Google route is left in place but makes no new logins (hook above). The phone app change ships in build 12.
- Checked on a scratch copy (port 4299): sign up POST refused and no row made; QA admin sign in still works; the create user hook and the no profile session both refused; a login with no profile lands on No access. Live: only credential logins, no Google ones, and the only login without a profile is the Play reviewer.

### 18.52 Five fixes: job value from the quote, dates DD/MM/YYYY, room under the mic (16 Oct)
- Job value (lib/job-value.ts, rewritten). One rule for Value on the job, the Jobs list, the dashboard and "What this job makes": an accepted quote gives its total plus accepted variations; with no accepted quote the newest quote counts (draft, sent or a new version); with no quote the typed value stays. The deposit follows the quote too, except an accepted or paid deposit, which stays. The old rule only synced when the first quote was no newer than the job, so jobs made on the New job screen and quoted later sat at $0. Saving a value on a quoted job (routes/jobs.ts update) now puts the quote figure back. The existing hooks (quote recalc, create, revise, copy, voice quotes, remove, decline) all go through syncJobValue.
- What this job makes (routes/costing.ts): the sale is now the job value taken back to ex GST, the same figure as Value. It used to be the quote subtotal, which disagreed whenever the value was stale or had variations on top. quoteThatCounts is shared with job-value.ts.
- Live jobs already sitting at the wrong value are fixed by a one off script only after Damien OKs the list (10 jobs at the time of writing).
- QA test accounts: live has none (no QA Ref installers or profiles). They were only on the scratch copy used for the phone screenshots. No code change.
- Dates (ui/date-field.tsx, new): every date box reads DD/MM/YYYY whatever language the computer or phone is set to. Input type="date" (ui/field.tsx) renders DateField: a text box that puts the slashes in as you type, plus a calendar button that opens the browser's own picker. It hands the page the same YYYY-MM-DD as before, through onChange and onBlur, so boxes that save on leave also save on a pick. A half typed or impossible date goes back to the last good one. The two raw date boxes on Conversations use it too. Dates shown as text use auDay (web lib/utils.ts, api lib/au-day.ts): forecasting, safety, public quote, care card, dashboard, office tasks, labour, costing, SWMS templates, book installer, and on the server the SWMS emails and log lines, job offer texts and pushes, the voice memo task line and the subcontractor invoice PDF date.
- Phone pages (styles.css): main gets 96px plus the safe area at the bottom in phone mode, so the round mic button never sits on the last card.
- Checked on a scratch copy (port 4299) with the browser set to en-US: the leads report boxes show 01/11/2025 and 16/10/2026, typing 01092026 sends 2026-09-01, a calendar pick sends 2026-10-20, 31/02/2026 goes back; the supplier "Price list dated" box saved 05/10/2026 on leave and kept it after a reload. Phone Jobs page: the last card clears the mic.
- Live, 16 Oct, with Damien's go-ahead: backup backups/pre-job-values.db (121 tables, 19332 rows, bad 0, integrity ok), dry run on a copy, then fix1016f/apply-jv.ts with APPLY=1. 10 jobs changed: 4389, 188002, 188003, 188004, 188005, 188006, 188007, 188009, 188010 (deposit only, to $825) and 188011. A second dry run on live finds 0 left.

### 18.53 Job value kept on the quote on every save and send (16 Oct)
Damien's ask: new quotes keep the job value up to date when they are saved or sent, so jobs never sit at the wrong value again.
- Before this, a few paths changed a quote or its job link without running the job value rule, so a job that had drifted stayed wrong until a line was edited. Now every one of them calls syncJobValue (lib/job-value.ts):
  - Save on a quote (routes/quotes.ts update): any field, not only deposit or status. If the quote's job changed, the old job is put right too.
  - Send: Mark as sent (quotes.send), Email the quote (routes/quoteSend.ts) and the timber repair send (lib/timber-repair.ts).
  - A job made for a quote (lib/quote-convert.ts createJobForQuote): once every version is on the job, the newest version sets the value.
  - Voice memos (routes/memos.ts): moving a memo's quote to another job syncs both jobs; taking back a memo that deletes its draft quote syncs the job.
- Already in place and unchanged: every line add, edit, remove, product change and labour change goes through recalc, which syncs; create, revise, copy, voice quotes, remove, decline and accept do too. A cancelled job keeps its last value.
- Bill to and deposit from the payer's card moves to 18.54, staff invites to 18.55.
- Checked on a scratch copy (fix1016g/t-jv, PASS 29): a job made first with a typed $500 then quoted takes the quote; add, edit and remove a line; a job set back to $0 by hand comes right on a notes save, a deposit change and on Send; a new version counts and deleting it goes back to v1; a New quote with its own job has the value from the start; accept gives the accepted total. The same test on the old code fails the save and send cases (3 fails).
