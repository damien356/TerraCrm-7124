# Terra Ops — Runbook

**Business: Terra Flooring only.** This system holds Terra Flooring data and nothing else. Floors by You and JSL Energy are separate projects with separate systems, separate databases and separate logins. Nothing here links to them, ever.

This is the "what if Runable goes bankrupt tomorrow" document. Everything below can be done by you, or by any developer you hire off the street, without us.

---

## 1. What the system actually is

| Piece | What it is | Where it lives |
| --- | --- | --- |
| Web app (office) | React app — schedule board, jobs, quotes, clients, installers, settings | `packages/web/src/web` |
| API | oRPC procedures — every rule about who can see what | `packages/web/src/api` |
| Database | SQLite, hosted by Turso | credentials in `.env` |
| Installer app | Expo / React Native — Today, Coming up, Offers, Me | `packages/mobile` |
| Design rules | Colours, fonts, permission rules in writing | `design.md` |
| Data model | Every table explained in plain English | `terra-ops-data-model.md` |

It is a standard Bun + Vite + React + Hono + Drizzle monorepo. Any competent web developer will recognise it on sight. There is no proprietary Runable language in the app code.

## 2. The accounts that must be in your name

Do this once. If an account is in someone else's name, you don't own it.

| Account | Why | Status |
| --- | --- | --- |
| GitHub (`damien@…`) | holds the code | **you create it — step 3** |
| Turso | holds the database | **must be your email** |
| Domain registrar | terraflooring.com.au | yours already |
| Twilio (later) | phone + SMS | Phase 5, not yet |
| Stripe (later) | card payments | Phase 3, not yet |
| Xero | accounting | yours already |

Rule of thumb: if you can't log in and change the password yourself, it isn't yours yet.

## 3. Mirror the code to your own GitHub (do this first)

1. Create a free account at github.com if you don't have one.
2. Make a **private** repository called `terra-ops`. Don't tick "add a README".
3. GitHub shows you a URL like `https://github.com/<you>/terra-ops.git`. Copy it.
4. Ask me to push, or run these in the app folder yourself:

```bash
git init
git add .
git commit -m "Terra Ops — Phase 1"
git branch -M main
git remote add origin https://github.com/<you>/terra-ops.git
git push -u origin main
```

From then on, `git push` after any change. The code now exists in a place we don't control.

**Never commit `.env`** — it holds database keys. There is a `.gitignore` for that; leave it alone.

## 4. Backups

### Click-a-button version (no terminal)

In the app: **Settings → Your data**.

- **Download full snapshot** — one JSON file, every table. This is the file that rebuilds everything.
- **CSV per table** — jobs, tasks, people, quotes, invoices, price list, etc. Opens in Excel.

Do the full snapshot on the first of every month and drop it in Google Drive. Two minutes.

### Nightly automatic version

```bash
cd <app folder>
bun run backup
```

Writes to `backups/<date>/`:

- `snapshot.json` — every table (the restore file)
- `<table>.csv` — one CSV per table
- `restore.sql` — `CREATE TABLE` + `INSERT` statements for a blank SQLite database
- `backups/latest.json` — always the newest snapshot

To make it nightly at 1am on any Linux box, `crontab -e` and add:

```
0 1 * * * cd /path/to/terra-ops && /usr/local/bin/bun run backup >> backups/backup.log 2>&1
```

Then sync the `backups` folder to Google Drive / Dropbox / OneDrive with their desktop app. **A backup on the same machine as the data is not a backup.**

## 5. Restoring — three levels of bad

### a) "I deleted something I shouldn't have"

Pull the relevant CSV from the newest `backups/<date>/` folder, find the row, re-enter it in the app. Two minutes.

### b) "The database is gone"

```bash
# make a new Turso database (or any SQLite file), then:
sqlite3 terra.db < backups/<date>/restore.sql
```

Point `DATABASE_URL` in `.env` at the new database. Restart. Done — `restore.sql` carries both the table structure and every row.

Locally, with no Turso at all:

```bash
DATABASE_URL="file:./terra.db" bun run dev
```

### c) "Runable is gone"

1. Clone your GitHub repo (step 3) onto any computer or any host — Vercel, Fly, Hetzner, a laptop.
2. `bun install`
3. Copy your `.env` values across (keep a printed or password-manager copy of them).
4. `cd packages/web && bun run db:push` to build the tables in a fresh database, or restore with `restore.sql`.
5. `bun run dev` for the office app, `bun run dev:mobile` for the installer app.

Nothing in the app requires Runable to be alive. The Runable-specific bits are: the managed login service (`@runablehq/managed-auth`) and the hosting. Both are replaceable — Better Auth, the library underneath, is open source and supports plain email/password plus your own Google credentials. That's a half-day job for a developer, not a rebuild.

## 6. The `.env` file — the only truly unrecoverable thing

`.env` in the app root holds:

```
DATABASE_URL=...
DATABASE_AUTH_TOKEN=...
```

Copy those two values into your password manager today. Everything else in this system can be rebuilt from the repo and a backup; these two lines cannot.

## 7. Day-to-day commands

| What you want | Command |
| --- | --- |
| Start the office app | `bun run dev` (port 4200) |
| Start the installer app | `bun run dev:mobile` (port 4300) |
| Back up everything | `bun run backup` |
| Push schema changes to the database | `cd packages/web && bun run db:push` |
| Load demo data again | `cd packages/web && bun --env-file=../../.env src/api/database/seed.ts` (safe to re-run) |
| Check the code still compiles | `bun run build` |

## 8. Who sees what — the rules that are enforced in code

Installers **can** see: their own tasks, the customer's name and phone, the address and access notes, the scope, their crew mate, materials by quantity, the checklist, and **their own pay**.

Installers **cannot** see, at any price: customer pricing, job value, margins, quotes, invoices, supplier costs, the price list, other installers' tasks, or other installers' rates.

This is enforced in the API (`packages/web/src/api/routes/field.ts`), not in the app screens. Even someone poking at the API with a browser console gets nothing. If a future developer adds an installer feature, it must go through `field.ts` — that is the whole safety model in one file.

## 9. First-login note

**The first person who ever signs in becomes the admin.** That must be you. Sign in before you invite anybody else. Everyone after that is created as an installer and has to be linked to an installer record by you in **Installers**.

## 10. What is not built yet (agreed phases)

- Phase 2 — installer invites, availability calendar, insurance expiry chasing, performance stats
- Phase 3 — Stripe payments, one-way push to Xero
- Phase 4 — CRM and campaigns (the ActiveCampaign replacement)
- Phase 5 — SMS/voice and the AI agent in your voice
- Phase 6 — website lead capture straight into jobs

Phone number strategy (port 0468 366 555 vs a new Twilio number) is still an open decision and belongs to Phase 5.
