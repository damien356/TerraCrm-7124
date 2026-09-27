# Terra Ops — Design

Job management, CRM and dispatch system for Terra Flooring (Gold Coast). Ships as an **admin web app** (office/dispatch — full access) and a **mobile app** (installers — restricted task cards). Visual direction: **dark and high-end** — charcoal chrome, gold accents off the Terra logo, warm stone neutrals. Premium dashboard, not cartoon trade software. Reference: ServiceM8's dispatch logic, executed cleaner and far more expensive-looking. **No avatars, no illustrated figures, anywhere** (Damien explicitly hates ServiceM8's cartoon staff icons).

## Brand & Colors

Gold sampled straight off the Terra Flooring logo artwork. Charcoal chrome + gold accents + warm stone neutrals. No purple, no cartoon colour, no decorative gradients — gradients only as subtle depth on dark chrome.

| Token | Value | Use |
|-------|-------|-----|
| `--gold` | `#BC9558` | **Primary action colour.** Buttons, active nav rule, accents, focus ring |
| `--gold-deep` | `#906F3C` | Pressed/darker gold |
| `--gold-pale` | `#C4B99F` | Gold text on dark |
| `--gold-wash` | `#F6F1E8` | Tinted surfaces, `--accent` |
| `--primary-foreground` | `#171614` | Dark text on gold (white on gold is too weak) |
| `--sidebar` | `#161513` | Sidebar + `.page-chrome` header bar |
| `--sidebar-accent` / `--sidebar-border` | `#23211E` / `#302D29` | Sidebar hover / hairlines |
| `--background` | `#F4F2EF` | Page background (warm stone) |
| `--card` | `#FFFFFF` | Cards, panels, grid cells |
| `--foreground` | `#171614` | Primary text |
| `--muted-foreground` | `#77706A` | Labels, secondary text |
| `--border` / `--input` | `#E3DFD9` / `#DDD8D1` | Hairlines, grid lines, inputs |
| `--success` | `#3F7D3A` | Complete, accepted, paid |
| `--warning` | `#C08A24` | To accept, pending, at risk |
| `--destructive` | `#B23B2C` | Declined, overdue, blocked |

**Shared component classes** (in `packages/web/src/web/styles.css`, `@layer components`):
`.page-chrome` — dark gradient header bar with a gold-tinted bottom border, wraps every page title · `.page-title` / `.page-sub` · `.gold-rule` — 1px gold→transparent hairline · `.th` — stone uppercase table header · `.card-surface` — card with `--shadow-card` · `.label-xs` · `.tabular`.
Buttons and inputs sitting inside `.page-chrome` are auto-inverted by unlayered CSS at the bottom of `styles.css` — don't hand-style them per page.

**Status colours** (job + task): Lead `#7A736D` · Quoted `#5B7A9E` · Won `#3F7D3A` · Scheduled `#4A7FA5` · In Progress `#C08A24` · Complete `#3F7D3A` · Invoiced `#5B6E7A` · Paid `#2E6B4F` · Cancelled `#7A736D`.

**Task-type tints** on the dispatch board (soft fill + 3px solid left edge): Carpet `#DCE8F2`/`#4A7FA5` · Resilient `#E2EFDF`/`#5C8A52` · Timber `#F5E8D8`/`#B07B3A` · Prep `#EDE9E4`/`#7A736D` · Demolition `#F7E2DE`/`#C0603F` · Trades `#EDE4F2`/`#7A6A9E`.

## Typography

**Manrope** throughout (400/500/600/700/800), loaded from Google Fonts in `styles.css` and set as `--font-sans`. Bold weights for page titles and stat numbers, tight tracking (`-0.015em`) on headings. Numbers tabular in the schedule grid and stats. Labels: 11px, uppercase, `0.09em` tracking, semibold, muted.

## Pages & Screens

**Web (admin)** — `packages/web/src/web/pages/`
- `login.tsx` — email/password + Google, charcoal split panel, gold sign-in button
- `index.tsx` — Dashboard: today's tasks, unfilled offers, jobs at risk, week revenue
- `schedule.tsx` — **the core screen.** Installer rows × day columns, tasks as draggable blocks, unassigned queue at the bottom, right-hand job panel
- `jobs.tsx` / `job-detail.tsx` — job list + full job (tasks, contacts, quote, photos, activity)
- `clients.tsx` / `contact-detail.tsx` / `companies.tsx` / `company-detail.tsx`
- `installers.tsx` — installer cards with skill ticks, crew capacity, rates
- `quotes.tsx` / `quote-builder.tsx`
- `settings.tsx` — skills, statuses, task types, rates, permissions

**Mobile (installer)** — `packages/mobile/app/`
- `login.tsx`, `(tabs)/index.tsx` (Today), `(tabs)/schedule.tsx`, `(tabs)/offers.tsx`, `(tabs)/me.tsx`, `task/[id].tsx`

## Key User Flows

1. **Dispatch** — job created → tasks added (skill + crew size) → each task assigned direct or broadcast to all installers with that skill → first accept wins, others close → board updates live.
2. **Field** — installer opens app → accepts offer → task card (navigate, access notes, scope, materials, checklist, photos) → mark complete → admin sees it on the board.
3. **Furniture rule** — job flagged *furniture on site* forces crew size 2 on install tasks; assigning 1 person is blocked.

## Rules baked in

- Installers see: their own tasks only, address, access notes, scope, materials, customer name + phone (admin toggle), their own pay.
- Installers never see: customer pricing, margins, quotes, invoices, supplier costs, other installers' tasks or rates.
- Enforced server-side in `packages/web/src/api/middleware/auth.ts` — never UI-only.
- Skills, statuses and task types are **editable data**, not hardcoded enums.

## Architecture

oRPC + Drizzle (Turso/SQLite). Query hooks in `src/web/queries/`. Drag-and-drop with native HTML5 DnD (no extra dep). Roles on the Better Auth user: `admin` | `installer`.
