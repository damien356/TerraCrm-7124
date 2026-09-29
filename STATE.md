# Terra Ops, current state

Read this first in any new chat, then `RUNBOOK.md`, `design.md` and
`marketing-plan.md`. This file is the single source of truth for where the system
is. Update it whenever something below stops being true, rather than re-deriving
history in chat.

Last updated: 29 September 2026. Verified against the live repo and the live
database on that date. Commit at time of writing: `b3d5342`.

**Terra Flooring only.** This system holds Terra Flooring data and nothing else.
Floors by You and JSL Energy are separate projects with separate databases and
separate logins. Nothing here links to them, ever.

---

## 1. Architecture and where things are

Project root `/home/user/terra-ops`. Bun workspace monorepo, Bun 1.3.14.

| Piece | What it is | Where it lives |
| --- | --- | --- |
| Office web app | React 19 and Vite, 26 pages | `packages/web/src/web` |
| API | oRPC procedures, 28 route files, all permission rules | `packages/web/src/api` |
| Database layer | Drizzle ORM against Turso SQLite | `packages/web/src/api/database` |
| Installer app | Expo and React Native, SDK 57 | `packages/mobile` |
| Desktop shell | Electron, scaffolded, not used | `packages/desktop` |
| Design rules | Colours, fonts, permission rules in writing | `design.md` |
| Disaster recovery | What to do if Runable disappears | `RUNBOOK.md` |
| Marketing build plan | Ten agreed steps, step 1 done | `marketing-plan.md` |
| Mobile release rules | OTA vs native rebuild, channels, rollback | `packages/mobile/UPDATES.md` |

Ports are fixed for the life of the app. Office 4200, mobile 4300, desktop 4400.

Note: `RUNBOOK.md` section 1 refers to `terra-ops-data-model.md`. That file does
not exist in the repo. Either write it or fix the reference.

---

## 2. Deployment and domains

Live office app: https://ops.terraflooring.com.au. Health check returns
`{"status":"ok"}`, confirmed 29 Sep 2026.

**The live site is served from this sandbox, and right now it is running the Vite
dev server, not pm2.** A tmux session `web` is running `bun run dev` from the
project root. `ecosystem.config.cjs` and `bun run start` exist for a proper pm2
production process, but pm2 is not the thing currently serving traffic. Worth
fixing before the crew depends on it, because a dev server is not a production
server.

Two chats booting the app against the same `DATABASE_URL` both write to real
data. Never run a migration or a push from a second sandbox while this one is
live.

The Runable preview URL for this app is
`https://terraop-l8jfdfu-preview-4200.runable.site`. It is the same app, same
database. It appears in `app.json` as the dev-time fallback API URL, see section
6.

Repo: `git@github.com:damien356/TerraCrm-7124.git`, branch `main`. Push after any
change. A recurring automatic push is still not set up.

---

## 3. Database

Turso hosted SQLite. 58 tables defined in
`packages/web/src/api/database/schema.ts`. Credentials live in the root `.env`
and nowhere else. `DATABASE_URL` and `DATABASE_AUTH_TOKEN` are the only two
values in the whole system that cannot be rebuilt from the repo plus a backup.
They belong in a password manager.

Live row counts, queried directly against production on 29 Sep 2026:

| Table | Rows |
| --- | --- |
| jobs | 4223 |
| products | 3996 |
| contacts | 1653 |
| companies | 287 |
| labour_rates | 44 |
| suppliers | 20 |
| messages | 6 |
| conversations | 6 |
| user | 5 |
| installers | 3 |
| quotes | 0 |
| invoices | 0 |
| job_tasks | 0 |
| job_costs | 0 |
| form_templates | 0 |
| device_tokens | 0 |
| journeys | 0 |
| segments | 0 |
| sends | 0 |
| email_templates | 0 |

Two of those need a decision, not an assumption.

- **quotes and invoices are both empty**, despite the quotes page, the quote
  builder and the invoices page all being built and substantial. Either no quote
  has ever been raised in the system, or quote data was lost or never imported.
  Not investigated yet. Do not claim either way until someone checks.
- **job_tasks and job_costs are empty.** Every scheduling and costing screen
  reads from these. With 4223 jobs and zero tasks, the schedule board has
  nothing real to show. Same question, unanswered.

Data that is real and loaded: jobs, contacts, companies, the price book, labour
rates and suppliers. Jobs carry `externalRef` and `category` columns that trace
back to the ServiceM8 import.

Key enums, so nothing invents new values:

- `jobStatuses.stage`: open, won, scheduled, active, complete, closed
- `quotes.status`: draft, sent, accepted, declined, expired
- `quoteItems.kind`: supply, labour, prep, removal, accessory, other

Jobs also hold `planUrl`, `planName` and `planMime`. The job plan attachment
shows on every task card in the installer app.

Schema commands: `bun run db:generate` after any `schema.ts` edit, then
`bun run db:migrate`. `bun run db:push` exists for direct pushes.

---

## 4. Auth and who sees what

Better Auth, in `packages/web/src/api/auth.ts`. Base path `/api/auth`, base URL
from `WEBSITE_URL`, Drizzle SQLite adapter, email and password enabled, secret in
`BETTER_AUTH_SECRET`. Trusted origins reflect the request origin. Two plugins:
`runableManagedAuth` for the managed login service, and `expo()` for the mobile
app's auth flow.

Two roles only: `admin` and `installer`. Resolved in
`packages/web/src/api/middleware/auth.ts`.

**The first person who ever signs in becomes admin.** Everyone after that is
created as an installer and has to be linked to an installer record by an admin
in the Installers page. This matters if the database is ever rebuilt. Whoever
signs in first on an empty database owns it. A profile with `active` false is
rejected with FORBIDDEN.

Installers **can** see: their own tasks, the customer's name and phone, the
address and access notes, the scope, their crew mate, materials by quantity, the
checklist, and their own pay.

Installers **cannot** see, at any price: customer pricing, job value, margins,
quotes, invoices, supplier costs, the price list, other installers' tasks, or
other installers' rates.

This is enforced in the API, in `packages/web/src/api/routes/field.ts`, not in
the app screens. Someone poking the API from a browser console gets nothing. Any
future installer feature must go through `field.ts`. That one file is the whole
safety model.

---

## 5. Office web app

26 pages in `packages/web/src/web/pages`, 11,296 lines.

Schedule board, jobs, job detail, quotes, quote builder, clients, companies,
company detail, contact detail, supervisors, supervisor detail, installers, crew
map, price book (products), suppliers, import review, team and logins,
conversations, settings, login, and five finance pages: cashflow, forecasting,
invoices, expenses, profitability.

Largest pages, as a rough map of where the weight sits: `settings.tsx` 1218,
`products.tsx` 1046, `suppliers.tsx` 809, `installers.tsx` 714, `job-detail.tsx`
712, `quote-builder.tsx` 651.

28 oRPC route files in `packages/web/src/api/routes`: areas, availability,
backups, companies, contacts, conversations, costing, crew, dashboard, devices,
field, finance, forms, installers, intel, jobs, labour, media, offers, ping,
products, quotes, review, settings, suppliers, tasks, team, upload.

The only plain HTTP route on the server is `/api/health`. Everything else is
oRPC.

---

## 6. Installer app

Expo org `terra-flooring`, owner `terra-flooring`, EAS project ID
`b38734e2-f558-43ce-86f4-a6ea2cafa28b`. Android package and iOS bundle
`au.com.terraflooring.terra`. Version 1.0.0, versionCode 5. Scheme
`runable-terraop-l8jfdfu`.

Expo SDK 57.0.25, React Native 0.86.3, expo-router 57.0.23.

Screens: login, auth callback, and tabs Today, Coming up (schedule), Offers, Me,
plus a task detail screen. There is also an **Office tab**. It calls
`dashboard.summary`, which is `adminOnly`, so it is the admin's morning screen on
the phone: what is on today, what is unfilled, pending offers, what is at risk,
counts and revenue. Crew never see it. Earlier notes listed only four tabs. Five
is correct.

Native permissions requested: camera, read media images, fine and coarse
location, post notifications, call phone, vibrate.

Plugins: expo-router, expo-secure-store, expo-web-browser, expo-font,
expo-location, expo-image-picker, expo-notifications, expo-splash-screen,
expo-updates.

### API URL, which is the confusing part

`expo.extra.apiUrl` in `app.json` is currently the Runable preview URL,
`https://terraop-l8jfdfu-preview-4200.runable.site`. That is the dev-time
fallback and it is platform managed. **Never hand-edit `expo.extra`.** The store
build does not use it. `eas.json` pins `EXPO_PUBLIC_API_URL` to
`https://ops.terraflooring.com.au` on the production profile, and that is what a
crew phone talks to.

### Build profiles

| Channel | Profile | Android output | Who has it |
| --- | --- | --- | --- |
| development | development | APK, dev client | Dev machine only |
| preview | preview | APK, sideloadable | Testing, before crew |
| production | production | AAB, store | Crew and office |

`cli.version >= 24.0.0`, `appVersionSource: remote`, production autoIncrement on.
iOS submission expects an App Store Connect key at
`packages/mobile/keys/AuthKey.p8`.

### Updates

`expo-updates` enabled, URL `https://u.expo.dev/b38734e2-...`,
`checkAutomatically: ON_LOAD`, `fallbackToCacheTimeout: 0` so the app never waits
on the network at startup. `runtimeVersion.policy` is `fingerprint`, so a native
change produces a new fingerprint and old binaries are never offered an update
that would crash them. The tooling enforces the rule, not discipline.

Three release categories, from `packages/mobile/UPDATES.md`:

1. **Backend only.** Deploy the web app. No store review, no crew action.
2. **OTA update.** JS and RN changes inside `packages/mobile`. `eas update`,
   applied on next cold open. Test on preview first, roll out at a percentage if
   risky.
3. **Native rebuild.** New native library, SDK upgrade, permissions, icon,
   splash, bundle ID, anything under `plugins`, or a version bump. Needs
   `eas build` plus a store submission. Days, not minutes, for iOS.

Rollback: `eas update:republish` to the last good group, or
`eas update:roll-back-to-embedded` to drop every OTA and return to the store
build's own JavaScript. Both land on next cold start, so tell the crew to fully
close and reopen Terra.

The bottom of the Me tab shows version, channel and update id, for example
`Terra 1.0.0 · production · update a1b2c3d4`. Ask for that line on any bug
report.

### Three rules, settled, do not revisit

1. The signing certificate fingerprint can never change. Google has it.
   `DB:E9:56:6E:A0:83:07:B0:6E:2F:E1:AC:02:08:B4:D6:46:BD:58:AB:88:51:C6:4D:C0:37:50:94:1A:0F:D3:98`
2. Never hand-edit `expo.extra` in `app.json`. The store build's API URL is
   pinned via `EXPO_PUBLIC_API_URL` in `eas.json`.
3. Splash config belongs in the `expo-splash-screen` plugin entry. Top-level
   `splash`, `newArchEnabled` and `android.edgeToEdgeEnabled` are dead keys in
   SDK 57 and are silently ignored.

**Never build an apk, aab or ipa in the sandbox. It kills the sandbox. Use EAS.**

Current artifact `/home/user/terra-release/Terra-1.0.0-build5.aab`, verified
against the built file. **Not yet uploaded to Google Play.** The upload keystore
lives on Expo's servers and is the only key that can sign this package. Do not
delete it.

---

## 7. Integrations

| Integration | Env keys | State |
| --- | --- | --- |
| Turso database | `DATABASE_URL`, `DATABASE_AUTH_TOKEN` | Live, in use |
| Runable managed login | `APPLICATION_ID`, `VITE_APPLICATION_ID`, `VITE_RUNABLE_AUTH_ISSUER`, `RUNABLE_URL` | Live, in use |
| Better Auth | `BETTER_AUTH_SECRET`, `WEBSITE_URL` | Live, in use |
| Resend, outbound email | `RESEND_API_KEY` | Live and working. DNS notes in `resend-dns-setup.md` |
| ClickSend, outbound SMS | `CLICKSEND_USERNAME`, `CLICKSEND_API_KEY`, `CLICKSEND_SENDER_ID`, `CLICKSEND_REPLY_NUMBER`, `CLICKSEND_TAG_ACMA_REGISTERED` | Live and working, with the caveat in section 9 |
| S3 file storage | `S3_ENDPOINT` (`https://t3.storage.dev`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Live. Presigned uploads, files go phone or browser straight to storage and never through the server |
| AI gateway | `AI_GATEWAY_API_KEY`, `AI_GATEWAY_BASE_URL` | Keys set, **nothing uses them** |
| Autumn payments | `AUTUMN_SECRET_KEY` | Key set, **nothing uses it** |

Xero and Stripe are not connected. They are Phase 3.

---

## 8. What is NOT built, despite looking like it is

**Marketing module: schema only.** Eight tables exist and are fully commented:
journeys, journeySteps, journeyEnrolments, emailTemplates, segments, sends,
emailEvents, unsubscribes. All confirmed empty in production. Nothing uses them.
No routes, no pages, no engine, and no worker process exists to run one.
`marketing-plan.md` describes ten build steps. Step 1 is done, steps 2 to 10 are
open. The agreed rules in that file are decided, not open: homeowners only for
anything automatic, builders fenced off in code, builders emailable by hand only,
and `marketingOptIn` plus no unsubscribe required before anything sends.

**Inbound email: not wired.** The helpers are written and waiting in
`api/lib/email.ts` and `api/lib/conversations.ts`, including per-conversation
reply addresses and real Message-ID threading. No webhook route is mounted and
`CONVERSATION_REPLY_TO` is not set. A customer reply cannot reach Terra Ops
today.

**AI: nothing.** Gateway keys set, unused. No agent, no routes, no prompts.

**CRM proper: partly there.** Contacts, companies, supervisors, conversations and
the job history are real and populated. What does not exist is any campaign,
segment, journey or automated follow-up. The ActiveCampaign and Brevo
replacement is Phase 4 and is not started.

**Forms: schema and route only.** `form_templates` is empty, so the checklist
system has nothing loaded.

**Push notifications: plumbing only.** `expo-notifications` is configured and
`devices.ts` exists, but `device_tokens` has zero rows, so nothing can be pushed
to anyone yet.

**Desktop app: scaffolded, unused.** Electron package exists. Nobody runs it.

Agreed remaining phases:

- Phase 2, installer invites, availability calendar, insurance expiry chasing,
  performance stats
- Phase 3, Stripe payments, one way push to Xero
- Phase 4, CRM and campaigns
- Phase 5, SMS and voice and the AI agent in Damien's voice
- Phase 6, website lead capture straight into jobs

Phone number strategy, porting 0468 366 555 versus a new Twilio number, is still
an open decision and belongs to Phase 5.

---

## 9. Live gotchas

- **SMS alpha tag "TerraFloors" arrives overstamped "Unverified"**, because it is
  not on the ACMA Sender ID Register. Confirmed on a real test text, 27 Sep 2026.
  Replies to it go nowhere. The dedicated number +61493089052 is two way, catches
  STOP automatically, $20.90 a month. `CLICKSEND_TAG_ACMA_REGISTERED` is false on
  purpose. The number is plumbing and is never advertised. 1300 1 TERRA is the
  only public number.
- **Three diag routes are live with no auth gate**: `diag`, `diagThrow`,
  `diagActor` in `api/routes/ping.ts`. Booleans and metadata only, no secrets.
  Leave them until there is a stable Play release, then delete.
- **Production is a dev server.** See section 2.
- **Empty quotes, invoices, job_tasks and job_costs.** See section 3.

---

## 10. Backups and disaster recovery

`backups/` holds `2026-08-28/`, `2026-09-26/` and `latest.json`. `latest.json` is
5.2 MB, last written 26 Sep 2026. So the last backup is three days old at the
time of writing, and it is manual.

`bun run backup` writes `snapshot.json`, per-table CSVs and a `restore.sql`, then
updates `backups/latest.json`. It is not on a cron yet. The suggested line from
`RUNBOOK.md`:

```
0 1 * * * cd /path/to/terra-ops && /usr/local/bin/bun run backup >> backups/backup.log 2>&1
```

In-app, Settings then Your data exports CSVs and a full JSON snapshot. The route
is `api/routes/backups.ts`, entirely adminOnly, no installer access.

Three recovery levels, all documented in `RUNBOOK.md`:

1. One row lost, restore it from the table's CSV.
2. Whole database lost, replay `restore.sql` into a fresh Turso database.
3. Runable itself gone, clone from GitHub, write a fresh `.env`, `db:push`, then
   replay the snapshot.

The only Runable specific dependencies are the managed login service and the
hosting. Both are replaceable. Swapping them is a half day job for a developer,
not a rebuild.

Accounts that must be in Damien's own name: GitHub, Turso, the domain registrar,
Xero. Later, Twilio and Stripe. Rule of thumb, if you cannot log in and change
the password yourself, it is not yours yet.

---

## 11. Commands

```bash
cd /home/user/terra-ops
bun run dev          # office app, 4200
bun run dev:mobile   # installer app, 4300
bun run typecheck    # passes clean
bun run build        # turbo build, checks it still compiles
bun run db:generate  # after any schema.ts edit
bun run db:migrate
bun run db:push
bun run start        # pm2 production start or restart
bun run backup
curl -s https://ops.terraflooring.com.au/api/health
```

Reload the demo data, safe to re-run:

```bash
cd packages/web && bun --env-file=../../.env src/api/database/seed.ts
```

Supplier and product catalogues are seeded from 21 `seed-products-*.ts` files
plus `seed-suppliers.ts`. The 20 supplier records include Terramater, Riverhill,
Sunstar Flooring, Airlay, Chameleon Flooring, Belgotex, Polyflor, Hurford's,
Woodmans Mitre 10 Beenleigh, ArtiFloor and Victoria Carpets, along with some
fee-type rows for baling, delivery and cutting.

---

## 12. Next jobs, in order

1. Upload build 5 to Google Play.
2. Answer the empty table question. Are quotes, invoices, job_tasks and job_costs
   empty because nothing has been entered, or because an import never ran. This
   blocks trusting the schedule board and the finance pages.
3. Move production off the Vite dev server onto pm2.
4. Put `bun run backup` on a cron.
5. Write and approve the marketing, conversations and AI architecture proposal.
   The inspection is done, it is sections 7 and 8. The proposal is not written.
   Damien's brief: one connected system, CRM to marketing to email and SMS to
   conversations to AI to jobs and quotes, replacing Brevo and ActiveCampaign,
   explicitly without building a second CRM. Approve before building.
6. Scope the recurring GitHub push, then set it up.

---

## 13. How Damien works

- No em dashes. Short plain sentences.
- Verify against the artifact, not the build log.
- Say when something is unverified. Correct a bad earlier claim out loud.
- Never change DNS, MX or production email config without showing him the exact
  change first.
- Decisions live in files, not in chat. Update this file instead of explaining
  history again.
