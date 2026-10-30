import type { Client, InStatement } from "@libsql/client";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { normaliseRole } from "../middleware/auth";

/* ---------------------------------------------------------------------------
 * Archive, restore and delete people (Damien, 30 Oct).
 *
 * A "person" is a login (profile) with whatever installer cards it has: its
 * crew card (profiles.installer_id) and its bookable staff card (staff_cards).
 * An installer card nobody logs in with is a person on its own.
 *
 *   Archive   main admin only. The login stops working at once, the cards
 *             leave every booking list, open offers to them are pulled back.
 *             Everything else is kept: ABN, rates, skills, jobs, pay, SWMS.
 *   Restore   main admin, or anyone the main admin ticked "Can restore people".
 *             Only the main admin can bring back an Admin.
 *   Delete    main admin only, and only for someone with no past work at all.
 *             Anyone with history is archived instead, so the record of who
 *             did a job, was paid, or signed a safety form always stays.
 *
 * The main admin can never be archived or deleted.
 * ------------------------------------------------------------------------- */

type Profile = typeof schema.profiles.$inferSelect;
type Card = typeof schema.installers.$inferSelect;

export type Person = {
  profile: Profile | null;
  /** Crew card and staff card for a login, or the one card for a card-only person. */
  cards: Card[];
  name: string;
};

export type PersonRef = { profileId: number } | { installerId: number };

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

export async function resolvePerson(ref: PersonRef): Promise<Person> {
  if ("installerId" in ref) {
    const [card] = await db.select().from(schema.installers).where(eq(schema.installers.id, ref.installerId));
    if (!card) throw new ORPCError("NOT_FOUND", { message: "Installer card not found" });
    const [crew] = await db.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.installerId, card.id));
    const [staff] = await db.select({ id: schema.staffCards.profileId }).from(schema.staffCards).where(eq(schema.staffCards.installerId, card.id));
    const owner = crew?.id ?? staff?.id;
    if (owner != null) return resolvePerson({ profileId: owner });
    return { profile: null, cards: [card], name: card.name };
  }
  const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, ref.profileId));
  if (!profile) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
  const ids = new Set<number>();
  if (profile.installerId) ids.add(profile.installerId);
  const [staff] = await db.select().from(schema.staffCards).where(eq(schema.staffCards.profileId, profile.id));
  if (staff) ids.add(staff.installerId);
  const cards = ids.size ? await db.select().from(schema.installers).where(inArray(schema.installers.id, [...ids])) : [];
  return { profile, cards, name: profile.name || profile.email || cards[0]?.name || "This person" };
}

export const isArchived = (p: Person) => (p.profile ? p.profile.archivedAt != null : p.cards[0]?.archivedAt != null);

function assertNotMainAdmin(p: Person, what: "archived" | "deleted") {
  if (p.profile?.isMainAdmin) throw bad(`The main admin can't be ${what}.`);
}

const actorLabel = (actor: Actor) => actor.name || actor.email || "Main admin";

async function logPerson(action: string, detail: string, actor: Actor) {
  await db
    .insert(schema.activityLog)
    .values({ entityType: "person", action, detail, actorName: actorLabel(actor), actorRole: actor.role })
    .catch((e) => console.error("[people] activity log failed", e));
}

/** Brisbane date, YYYY-MM-DD. */
const todayHere = () => new Date(Date.now() + 10 * 3600_000).toISOString().slice(0, 10);

/** Bookings still ahead for these cards. Archiving never moves them: the office does. */
export async function upcomingBookings(cardIds: number[]) {
  if (!cardIds.length) return [];
  const today = todayHere();
  const rows = await db.all<{ task_id: number; job_id: number; title: string; date: string | null; job_number: string | number | null }>(sql`
    select t.id as task_id, t.job_id, t.title, coalesce(
             (select min(d.date) from task_days d where d.task_id = t.id and d.status != 'cancelled' and d.date >= ${today}),
             t.scheduled_date) as date,
           j.number as job_number
      from job_tasks t join jobs j on j.id = t.job_id
     where t.status not in ('complete', 'cancelled')
       and (t.assigned_installer_id in (${sql.join(cardIds, sql`, `)}) or t.second_installer_id in (${sql.join(cardIds, sql`, `)})
            or exists (select 1 from task_days d where d.task_id = t.id and d.status != 'cancelled' and d.date >= ${today}
                        and d.installer_id in (${sql.join(cardIds, sql`, `)})))
       and (t.scheduled_date is null or t.scheduled_date >= ${today}
            or exists (select 1 from task_days d where d.task_id = t.id and d.status != 'cancelled' and d.date >= ${today}))
     order by date
     limit 50`);
  return rows.map((r) => ({ taskId: r.task_id, jobId: r.job_id, title: r.title, date: r.date, jobNumber: r.job_number == null ? null : String(r.job_number) }));
}

/* --------------------------------- archive -------------------------------- */

export async function archivePerson(p: Person, actor: Actor) {
  assertNotMainAdmin(p, "archived");
  if (p.profile && p.profile.userId === actor.userId) throw bad("You can't archive yourself.");
  if (isArchived(p)) throw bad(`${p.name} is already archived.`);
  const now = new Date();
  const by = actorLabel(actor);

  if (p.profile) {
    // The guard is in the write too, so the main admin can never be caught by it.
    const done = await db
      .update(schema.profiles)
      .set({ active: false, archivedAt: now, archivedByName: by, updatedAt: now })
      .where(and(eq(schema.profiles.id, p.profile.id), eq(schema.profiles.isMainAdmin, false)))
      .returning({ id: schema.profiles.id });
    if (!done.length) throw bad("The main admin can't be archived.");
    // An invite link still out there stops working too.
    await db
      .update(schema.invites)
      .set({ voidedAt: now, updatedAt: now })
      .where(and(eq(schema.invites.profileId, p.profile.id), isNull(schema.invites.usedAt), isNull(schema.invites.voidedAt)));
  }

  // Cards already archived by a level change stay as they were, so restore leaves them alone.
  const live = p.cards.filter((c) => !c.archivedAt).map((c) => c.id);
  if (live.length) {
    await db
      .update(schema.installers)
      .set({ active: false, archivedAt: now, archivedByName: by, updatedAt: now })
      .where(inArray(schema.installers.id, live));
  }
  const cardIds = p.cards.map((c) => c.id);
  const pulled = await withdrawOffers(cardIds);
  const upcoming = await upcomingBookings(cardIds);
  await logPerson("person_archived", `Archived ${p.name}. Login off, out of booking, everything kept.`, actor);
  return { ok: true as const, name: p.name, offersPulled: pulled, upcoming };
}

/** Open offers and holds to these cards are pulled back. A task left with none goes back to unassigned. */
async function withdrawOffers(cardIds: number[]) {
  if (!cardIds.length) return 0;
  const now = new Date();
  const pulled = await db
    .update(schema.taskOffers)
    .set({ status: "withdrawn", provisionalUntil: null, respondedAt: now, updatedAt: now })
    .where(and(inArray(schema.taskOffers.installerId, cardIds), inArray(schema.taskOffers.status, ["pending", "provisional"])))
    .returning({ taskId: schema.taskOffers.taskId });
  const taskIds = [...new Set(pulled.map((r) => r.taskId))];
  for (const taskId of taskIds) {
    const [open] = await db
      .select({ id: schema.taskOffers.id })
      .from(schema.taskOffers)
      .where(and(eq(schema.taskOffers.taskId, taskId), inArray(schema.taskOffers.status, ["pending", "provisional"])))
      .limit(1);
    if (!open) {
      await db
        .update(schema.jobTasks)
        .set({ status: "unassigned", updatedAt: now })
        .where(and(eq(schema.jobTasks.id, taskId), eq(schema.jobTasks.status, "offered")));
    }
  }
  return pulled.length;
}

/* --------------------------------- restore -------------------------------- */

export async function restorePerson(p: Person, actor: Actor) {
  if (!isArchived(p)) throw bad(`${p.name} is not archived.`);
  if (p.profile && normaliseRole(p.profile.role) === "admin" && !actor.isMainAdmin) {
    throw bad("Only the main admin can bring back an Admin.");
  }
  const now = new Date();
  if (p.profile) {
    await db
      .update(schema.profiles)
      .set({ active: true, archivedAt: null, archivedByName: null, updatedAt: now })
      .where(eq(schema.profiles.id, p.profile.id));
    // Only the cards this archive put away. A crew card archived by an earlier level change stays put.
    const mine = p.cards.filter((c) => c.archivedAt && c.archivedByName).map((c) => c.id);
    if (mine.length) {
      await db
        .update(schema.installers)
        .set({ active: true, archivedAt: null, archivedByName: null, updatedAt: now })
        .where(and(inArray(schema.installers.id, mine), isNotNull(schema.installers.archivedAt)));
    }
  } else {
    await db
      .update(schema.installers)
      .set({ active: true, archivedAt: null, archivedByName: null, updatedAt: now })
      .where(eq(schema.installers.id, p.cards[0]!.id));
  }
  await logPerson("person_restored", `Restored ${p.name}.`, actor);
  return { ok: true as const, name: p.name, hasLogin: Boolean(p.profile) };
}

/* ---------------------------------- history -------------------------------- */

/** Anything here means the person did work for Terra, so they can only be archived. */
const CARD_HISTORY: Array<[table: string, column: string, label: string, extra?: string]> = [
  ["job_tasks", "assigned_installer_id", "job tasks"],
  ["job_tasks", "second_installer_id", "job tasks"],
  ["task_days", "installer_id", "booked days"],
  ["task_offers", "installer_id", "accepted job offers", "status = 'accepted'"],
  ["task_photos", "installer_id", "job photos"],
  ["job_media", "uploaded_by_installer_id", "uploaded files"],
  ["callback_costs", "installer_id", "callback costs"],
  ["messages", "installer_id", "messages"],
  ["job_costs", "installer_id", "job costs"],
  ["form_submissions", "installer_id", "forms"],
  ["repair_requests", "installer_id", "repair requests"],
  ["work_sessions", "installer_id", "hourly shifts"],
  ["work_time_events", "installer_id", "time records"],
  ["site_visits", "installer_id", "site visits"],
  ["voice_actions", "installer_id", "voice requests"],
  ["swms_records", "installer_id", "SWMS sign-offs"],
  ["swms_flags", "installer_id", "safety flags"],
  ["installer_account_entries", "installer_id", "account entries"],
  ["installer_invoices", "installer_id", "installer invoices"],
  ["installer_variation_requests", "installer_id", "variation requests"],
  ["installer_buyer_links", "installer_id", "Xero contact links"],
  ["xero_contras", "installer_id", "Xero contras"],
  ["calendar_overrides", "installer_id", "calendar approvals"],
  ["stock_movements", "installer_id", "stock movements"],
];

const PROFILE_HISTORY: Array<[table: string, column: string, label: string]> = [
  ["job_media", "uploaded_by_profile_id", "uploaded files"],
  ["voice_quote_captures", "captured_by_profile_id", "voice quotes"],
  ["messages", "author_profile_id", "messages"],
  ["office_tasks", "assigned_profile_id", "office tasks"],
  ["form_submissions", "reviewed_by_profile_id", "form reviews"],
  ["purchase_orders", "created_by_profile_id", "purchase orders"],
  ["quote_followups", "assigned_profile_id", "quote follow-ups"],
  ["calendar_overrides", "approved_by_profile_id", "calendar approvals"],
  ["stocktakes", "approved_by_profile_id", "stocktakes"],
  ["stocktakes", "counted_by_profile_id", "stocktakes"],
  ["stock_movements", "by_profile_id", "stock movements"],
  ["mail_accounts", "connected_by_profile_id", "connected mailboxes"],
  ["xero_connection", "connected_by_profile_id", "Xero connection"],
];

const USER_HISTORY: Array<[table: string, column: string, label: string]> = [
  ["price_imports", "actor_user_id", "price imports"],
  ["product_deletes", "actor_user_id", "price book deletes"],
  ["quote_agent_messages", "user_id", "quote helper messages"],
  ["installer_buyer_links", "confirmed_by_user_id", "Xero link checks"],
  ["audit_events", "actor_user_id", "audit records"],
];

async function tableNames() {
  const rows = await db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`);
  return new Set(rows.map((r) => r.name));
}

export type HistoryLine = { label: string; count: number };

export async function historyOf(p: Person): Promise<HistoryLine[]> {
  const have = await tableNames();
  const totals = new Map<string, number>();
  const add = (label: string, n: number) => n > 0 && totals.set(label, (totals.get(label) ?? 0) + n);
  const cardIds = p.cards.map((c) => c.id);

  const count = async (table: string, column: string, values: Array<number | string>, extra?: string) => {
    if (!values.length || !have.has(table)) return 0;
    const where = sql`${sql.identifier(column)} in (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
    const [row] = await db.all<{ n: number }>(
      sql`select count(*) as n from ${sql.identifier(table)} where ${where}${extra ? sql.raw(` and ${extra}`) : sql``}`,
    );
    return Number(row?.n ?? 0);
  };

  for (const [t, c, label, extra] of CARD_HISTORY) add(label, await count(t, c, cardIds, extra));
  if (p.profile) {
    for (const [t, c, label] of PROFILE_HISTORY) add(label, await count(t, c, [p.profile.id]));
    for (const [t, c, label] of USER_HISTORY) add(label, await count(t, c, [p.profile.userId]));
  }
  return [...totals].map(([label, n]) => ({ label, count: n }));
}

/** "12 job tasks, 3 SWMS sign-offs and 1 account entry" style, kept plain. */
export function sayHistory(lines: HistoryLine[]) {
  const one = (label: string) =>
    label.endsWith("ies") ? `${label.slice(0, -3)}y` : label.endsWith("xes") ? label.slice(0, -2) : label.endsWith("s") ? label.slice(0, -1) : label;
  const parts = lines.map((l) => `${l.count} ${l.count === 1 ? one(l.label) : l.label}`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/* ---------------------------------- delete --------------------------------- */

/** Setup rows that belong to the person alone. They go with them. */
const CARD_SETUP: Array<[table: string, column: string, extra?: string]> = [
  ["installer_skills", "installer_id"],
  ["installer_locations", "installer_id"],
  ["labour_rates", "installer_id"],
  ["rate_acknowledgements", "installer_id"],
  ["installer_unavailability", "installer_id"],
  ["installer_pay_terms", "installer_id"],
  ["task_offers", "installer_id", "status != 'accepted'"],
  ["voice_keys", "installer_id"],
  ["conversation_participants", "installer_id"],
  ["staff_cards", "installer_id"],
];

let deleting = false;

export async function deletePerson(p: Person, actor: Actor) {
  assertNotMainAdmin(p, "deleted");
  if (p.profile && p.profile.userId === actor.userId) throw bad("You can't delete yourself.");
  if (deleting) throw bad("Another delete is still running. Try again in a moment.");
  deleting = true;
  try {
    const history = await historyOf(p);
    if (history.length) {
      throw bad(`${p.name} has history in Ops (${sayHistory(history)}), so they can't be deleted. Archive them instead. That keeps the record of who did the work.`);
    }
    const have = await tableNames();
    const stmts: InStatement[] = [];
    const cardIds = p.cards.map((c) => c.id);
    const inList = (ids: Array<number | string>) => ids.map(() => "?").join(", ");

    if (cardIds.length) {
      const q = inList(cardIds);
      if (have.has("calendar_links")) {
        if (have.has("calendar_busy")) {
          stmts.push({ sql: `delete from calendar_busy where link_id in (select id from calendar_links where installer_id in (${q}))`, args: cardIds });
        }
        stmts.push({ sql: `delete from calendar_links where installer_id in (${q})`, args: cardIds });
      }
      for (const [t, c, extra] of CARD_SETUP) {
        if (!have.has(t)) continue;
        stmts.push({ sql: `delete from ${t} where ${c} in (${q})${extra ? ` and ${extra}` : ""}`, args: cardIds });
      }
      if (have.has("vehicles")) stmts.push({ sql: `update vehicles set usual_driver_id = null where usual_driver_id in (${q})`, args: cardIds });
      stmts.push({ sql: `update profiles set installer_id = null where installer_id in (${q})`, args: cardIds });
    }

    if (p.profile) {
      const pid = p.profile.id;
      const uid = p.profile.userId;
      if (have.has("calendar_links")) {
        if (have.has("calendar_busy")) {
          stmts.push({ sql: "delete from calendar_busy where link_id in (select id from calendar_links where owner_profile_id = ?)", args: [pid] });
        }
        stmts.push({ sql: "delete from calendar_links where owner_profile_id = ?", args: [pid] });
      }
      for (const [t, c] of [
        ["staff_cards", "profile_id"],
        ["invites", "profile_id"],
        ["message_mentions", "profile_id"],
        ["conversation_participants", "profile_id"],
      ] as const) {
        if (have.has(t)) stmts.push({ sql: `delete from ${t} where ${c} = ?`, args: [pid] });
      }
      for (const [t, c] of [
        ["device_tokens", "user_id"],
        ["voice_keys", "user_id"],
        ["session", "user_id"],
        ["account", "user_id"],
      ] as const) {
        if (have.has(t)) stmts.push({ sql: `delete from ${t} where ${c} = ?`, args: [uid] });
      }
      // Last guard in the write itself: never the main admin.
      stmts.push({ sql: "delete from profiles where id = ? and is_main_admin = 0", args: [pid] });
      stmts.push({ sql: "delete from user where id = ? and not exists (select 1 from profiles where user_id = ?)", args: [uid, uid] });
    }

    if (cardIds.length) {
      stmts.push({ sql: `delete from installers where id in (${inList(cardIds)})`, args: cardIds });
    }

    // One transaction: it all goes, or none of it does.
    await (db.$client as Client).batch(stmts, "write");
    await logPerson("person_deleted", `Deleted ${p.name}. They had no history in Ops.`, actor);
    return { ok: true as const, name: p.name };
  } finally {
    deleting = false;
  }
}
