# Terra Ops runbook

## Current off-site backup, added 5 October 2026

Supabase is a backup copy. The live app still uses Turso and Tigris.

In your Supabase project:

- **Table Editor**, choose schema **terra_backup**. It contains the latest copied business tables. Edits here do not update Terra Ops and are replaced at the next backup.
- **Storage**, open the private bucket **terra-backup**.
- **database/latest.sqlite.gz** is the latest restorable database. **database/latest.json** records its time, per-table counts and any errors.
- **app-files/** contains the photos, videos, PDFs and voice recordings, using their original storage keys.
- **sandbox/latest.json** maps each backed-up sandbox file to a checksummed, compressed object in **sandbox/objects/**. Historic manifests are retained in **sandbox/manifests/**.

The first complete sandbox copy contains 1,681 files. The final refresh contains 1,684 files. All new objects were downloaded again and their SHA256 checksums verified. A downloaded database passed integrity and row-count checks. Every one of the 55 live storage objects matched its copied checksum.

### What is excluded

Passwords and password hashes, login sessions, verification codes, API keys, access tokens, private signing keys and credential files. Old local database files and ZIPs are sanitised before upload. Credentials in recognised fields and known literals in text are filtered. This is not an infallible detector for a password photographed in an image or spoken in audio.

Dependencies, caches, platform tools, compiled app packages and raw Git history are excluded. Business code, including unfinished code, attachments, price lists, plans, chat histories and sanitised historical database copies are included. Git history stays in Damien's GitHub repository. Android release packages can be rebuilt; keep the private signing key in your own password manager or other secure owner-controlled store.

### Run and verify

From the app folder:

```bash
bun --env-file=.env tools/supabase-backup.ts
bun --env-file=.env tools/verify-offsite-backup.ts
```

The uploader fails if any file cannot be safely copied. It does not mark an incomplete sandbox copy as complete. Unchanged sandbox files are not uploaded again. No automatic pruning is enabled. Retained snapshots consume storage, so monitor project usage and decide a retention period before deleting anything.

The platform's six-hour schedule must be saved by Damien. The published-server backup hook is also built, but not live until Damien publishes. That hook protects the live database and media if the sandbox is lost, not the sandbox-only working files. A scheduled task cannot recover files created after the last successful backup, and no backup guarantees zero data loss.

### Restore the database

1. In Supabase Storage, download **database/latest.sqlite.gz** and **database/latest.json**.
2. Decompress the `.gz` file to a new SQLite file.
3. Check `PRAGMA integrity_check` and table counts against the JSON manifest.
4. A developer can import it into a new Turso database, or use the SQLite file locally. Do not overwrite the live database during a drill.
5. Recreate credentials securely. Users must reset passwords. Reconnect mail accounts and re-register devices/Siri keys as needed. Sessions and verification codes are intentionally absent.
6. Restore media from **app-files/** to a replacement bucket with the same keys, then update storage configuration and any permanent URLs. Never put secrets into the backup.

### Restore sandbox files

Use a new, empty destination, never the working app:

```bash
bun --env-file=.env tools/restore-sandbox-backup.ts /absolute/path/to/empty-folder
```

To use an older copy, pass its `sandbox/manifests/...json` key as a third argument. The restore checks every checksum and refuses path traversal. Reinstall dependencies and configure fresh secrets before running the restored app.

If the sandbox itself no longer exists, download the manifest in Supabase Storage. For each file entry, download its `object`, gunzip it, verify its SHA256, and save it under the entry's relative path. The manifest format is plain JSON and does not require Runable.

### Plan and limits

At verification, total bucket usage was about 436 MB including pre-existing backups. The new content-addressed sandbox objects used about 136 MB. Free is adequate for setup, not unlimited retained backups. Pro was recommended, not purchased. Pricing: https://supabase.com/pricing.

There are four old test-photo references in live `job_media`, IDs 2 to 5, whose files do not exist in the source bucket. Their keys start `test/demo-completion-`. No real files were removed or invented to replace them. All existing source objects were copied.

## Legacy runbook below

Some account, phase and integration notes below predate the current build. The off-site instructions above and Damien's current rules take precedence. Never use `db:push` on Terra's live database. Inspect, back up, and apply only missing additive SQL.

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
4. Restore the backed-up SQLite database or `restore.sql`. Never run `db:push` on the live database.
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
| Change the database schema | Inspect first, take a backup, then apply only missing additive SQL. Never `db:push`. |
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
