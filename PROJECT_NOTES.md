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
