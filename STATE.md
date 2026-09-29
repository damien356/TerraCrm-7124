# Terra Ops, current state

One page. Read this first in any new chat, then `RUNBOOK.md` and `design.md`.
Update it whenever something below stops being true. Keep it one page. If it
grows past that, something belongs in a different file.

Last updated: 29 September 2026

---

## Where things are

Project `/home/user/terra-ops`. Bun, Vite, React, Hono, Drizzle, Expo monorepo.
Office app on port 4200, mobile 4300, desktop 4400. Ports are fixed for the life
of the app.

Live office app: https://ops.terraflooring.com.au, served from this sandbox.
Repo: `git@github.com:damien356/TerraCrm-7124.git`, branch `main`.
Database: Turso SQLite, 58 tables, credentials in root `.env` and nowhere else.

**Terra Flooring only.** Floors by You and JSL Energy are separate systems with
separate databases. Nothing here ever links to them.

---

## What is built and working

Office web app, 26 pages: schedule board, jobs, quotes, quote builder, clients,
companies, supervisors, contacts, installers, crew map, price book, suppliers,
import review, logins, settings, and five finance pages (cashflow, forecasting,
invoices, expenses, profitability).

API, 28 oRPC route files. Installer Expo app: Today, Coming up, Offers, Me.

Outbound email through Resend works. Outbound SMS through ClickSend works.
Conversations exist and thread against jobs and quotes.

---

## What is NOT built, despite looking like it is

**Marketing module: schema only.** Eight tables exist and are fully commented
(journeys, journeySteps, journeyEnrolments, emailTemplates, segments, sends,
emailEvents, unsubscribes). Nothing uses them. No routes, no pages, no engine,
and no worker process exists to run one. `marketing-plan.md` describes ten build
steps; step 1 is done and steps 2 to 10 are open.

**Inbound email: not wired.** The helpers are written and waiting in
`api/lib/email.ts` and `api/lib/conversations.ts`, including per-conversation
reply addresses and real Message-ID threading. No webhook route is mounted, and
`CONVERSATION_REPLY_TO` is not set. The only plain HTTP route on the server is
`/api/health`. So a customer reply cannot reach Terra Ops today.

**AI: nothing.** Gateway keys are set in `.env`, unused.

---

## Live gotchas

- **SMS alpha tag "TerraFloors" arrives overstamped "Unverified"**, because it is
  not on the ACMA Sender ID Register. Confirmed on a real test text, 27 Sep 2026.
  Replies to it go nowhere. The dedicated number +61493089052 is two way, catches
  STOP automatically, $20.90/month. `CLICKSEND_TAG_ACMA_REGISTERED` is false on
  purpose. The number is plumbing, never advertised. 1300 1 TERRA is the only
  public number.
- **Three diag routes are live with no auth gate**: `diag`, `diagThrow`,
  `diagActor` in `api/routes/ping.ts`. Booleans and metadata only, no secrets.
  Leave until there is a stable Play release, then delete.
- **The live site runs from this sandbox.** Two chats booting the app against the
  same `DATABASE_URL` both write to real data. Never run a migration from a
  second sandbox while this one is live.

---

## Installer app

Expo org `terra-flooring`, project `@terra-flooring/terra`, ID
`b38734e2-f558-43ce-86f4-a6ea2cafa28b`, package and bundle
`au.com.terraflooring.terra`, version 1.0.0 versionCode 5.

Current artifact `/home/user/terra-release/Terra-1.0.0-build5.aab`, verified
against the built file. **Not yet uploaded to Google Play.**

Three rules, settled, do not revisit:

1. Signing certificate fingerprint can never change. Google has it.
   `DB:E9:56:6E:A0:83:07:B0:6E:2F:E1:AC:02:08:B4:D6:46:BD:58:AB:88:51:C6:4D:C0:37:50:94:1A:0F:D3:98`
2. Never hand-edit `expo.extra` in `app.json`. It is platform managed. The store
   build's API URL is pinned via `EXPO_PUBLIC_API_URL` in `eas.json`.
3. Splash config belongs in the `expo-splash-screen` plugin entry. Top-level
   `splash`, `newArchEnabled` and `android.edgeToEdgeEnabled` are dead keys in
   SDK 57 and are silently ignored.

Never build an apk, aab or ipa in the sandbox. It kills the sandbox. Use EAS.

---

## Next jobs, in order

1. Upload build 5 to Google Play.
2. Write and approve the marketing, conversations and AI architecture proposal.
   The inspection is done, it is the three sections above. The proposal is not
   written. Damien's brief: one connected system, CRM to marketing to email and
   SMS to conversations to AI to jobs and quotes, replacing Brevo and
   ActiveCampaign, explicitly without building a second CRM. Approve before
   building.
3. Scope the recurring GitHub push, then set it up.

---

## How Damien works

- No em dashes. Short plain sentences.
- Verify against the artifact, not the build log.
- Say when something is unverified. Correct a bad earlier claim out loud.
- Never change DNS, MX or production email config without showing him the exact
  change first.
- Decisions live in files, not in chat. Update this file instead of explaining
  history again.

---

## Commands

```bash
cd /home/user/terra-ops
bun run dev          # office app, 4200
bun run dev:mobile   # installer app, 4300
bun run typecheck    # passes clean
bun run db:generate  # after any schema.ts edit
bun run db:migrate
bun run start        # pm2 production restart
bun run backup
curl -s https://ops.terraflooring.com.au/api/health
```
