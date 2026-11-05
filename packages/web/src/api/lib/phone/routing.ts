import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { localDate } from "../local-date";
import { ruleFor, type CallType, type Destination, type PhoneConfig } from "./config";

/* ---------------------------------------------------------------------------
 * Who owns a piece of phone work (Retell, 5 Nov).
 *
 * The order, every time, written into `steps` so the routing test and the
 * follow-up both say why:
 *   1. an existing-job call goes to the job's manager when the setting is on,
 *   2. otherwise the call type's destination (person, team, role, duty),
 *   3. each person is checked: active, not archived, office or admin, and not
 *      on leave. Leave cover or a delegation passes it to the cover person,
 *   4. nobody available: the rule's backup person, then the duty person,
 *   5. still nobody: it waits in the default queue, unowned.
 * ------------------------------------------------------------------------- */

export type Person = { id: number; name: string; role: string; active: boolean; archived: boolean; email: string; userId: string; phone: string | null };

export type Route = {
  ownerProfileId: number | null;
  ownerName: string;
  queueKey: string;
  steps: string[];
  /** Short line stored on the follow-up. */
  via: string;
};

async function peopleById(ids: number[]) {
  const want = [...new Set(ids)];
  if (!want.length) return new Map<number, Person>();
  const rows = await db.select().from(schema.profiles).where(inArray(schema.profiles.id, want));
  return new Map(
    rows.map((r) => [r.id, { id: r.id, name: r.name || r.email || `Person ${r.id}`, role: r.role, active: r.active, archived: !!r.archivedAt, email: r.email, userId: r.userId, phone: r.phone }]),
  );
}

export async function personOf(id: number | null | undefined): Promise<Person | null> {
  if (!id) return null;
  return (await peopleById([id])).get(id) ?? null;
}

/** Why this person can't take work right now, or null when they can. */
function unavailable(p: Person | undefined): string | null {
  if (!p) return "no longer exists";
  if (p.archived) return "is archived";
  if (!p.active) return "is switched off";
  if (p.role !== "admin" && p.role !== "office") return "is not office staff";
  return null;
}

/** The cover or delegate for a person on a date, or null. */
export async function coverFor(profileId: number, date: string) {
  const [row] = await db
    .select()
    .from(schema.staffCover)
    .where(
      and(
        eq(schema.staffCover.profileId, profileId),
        isNull(schema.staffCover.cancelledAt),
        sql`${schema.staffCover.fromDate} <= ${date}`,
        sql`(${schema.staffCover.toDate} is null or ${schema.staffCover.toDate} >= ${date})`,
      ),
    )
    // Dated leave beats a standing delegation.
    .orderBy(sql`case when ${schema.staffCover.kind} = 'leave' then 0 else 1 end`, sql`${schema.staffCover.id} desc`)
    .limit(1);
  return row ?? null;
}

/**
 * Follow a person through leave cover and delegation to someone who can take
 * the work. Null when the chain ends at nobody.
 */
async function settle(profileId: number, date: string, steps: string[], seen = new Set<number>()): Promise<Person | null> {
  for (let hop = 0; hop < 5; hop++) {
    if (seen.has(profileId)) {
      steps.push("Cover goes round in a circle, stopped.");
      return null;
    }
    seen.add(profileId);
    const p = (await peopleById([profileId])).get(profileId);
    const why = unavailable(p);
    if (why) {
      steps.push(`${p?.name ?? `Person ${profileId}`} ${why}.`);
      return null;
    }
    const cover = await coverFor(profileId, date);
    if (!cover) return p!;
    steps.push(`${p!.name} ${cover.kind === "leave" ? `is on leave until ${cover.toDate}` : "has delegated their work"}, so it passes to their ${cover.kind === "leave" ? "cover" : "delegate"}.`);
    profileId = cover.coverProfileId;
  }
  steps.push("Too many hops of cover, stopped.");
  return null;
}

/** Who work for this person actually lands with today, after leave cover and delegation. */
export async function settlePerson(profileId: number, date: string) {
  const steps: string[] = [];
  const person = await settle(profileId, date, steps);
  return { person, steps };
}

/** How many open follow-ups each person holds, to spread team work. */
async function openLoad(ids: number[]) {
  if (!ids.length) return new Map<number, number>();
  const rows = await db
    .select({ id: schema.phoneFollowups.ownerProfileId, n: sql<number>`count(*)` })
    .from(schema.phoneFollowups)
    .where(and(inArray(schema.phoneFollowups.ownerProfileId, ids), ne(schema.phoneFollowups.status, "resolved")))
    .groupBy(schema.phoneFollowups.ownerProfileId);
  return new Map(rows.map((r) => [r.id!, Number(r.n)]));
}

/** The people a destination names, in the order to try them. */
export async function membersOf(cfg: PhoneConfig, dest: Destination, steps: string[]): Promise<number[]> {
  switch (dest.kind) {
    case "profile":
      return [dest.profileId];
    case "duty":
      if (!cfg.dutyProfileId) steps.push("No duty person is set.");
      return cfg.dutyProfileId ? [cfg.dutyProfileId] : [];
    case "queue":
      return [];
    case "role": {
      const rows = await db
        .select({ id: schema.profiles.id })
        .from(schema.profiles)
        .where(and(eq(schema.profiles.role, dest.role), eq(schema.profiles.active, true), isNull(schema.profiles.archivedAt)))
        .orderBy(schema.profiles.id);
      return rows.map((r) => r.id);
    }
    case "team": {
      const t = cfg.teams.find((x) => x.key === dest.teamKey);
      if (!t) steps.push(`Team "${dest.teamKey}" does not exist.`);
      else if (!t.memberIds.length) steps.push(`${t.name} has nobody in it.`);
      return t?.memberIds ?? [];
    }
  }
}

export function destLabel(cfg: PhoneConfig, d: Destination | null | undefined, names: Map<number, string> = new Map()) {
  if (!d) return "nobody";
  if (d.kind === "profile") return names.get(d.profileId) ?? `person ${d.profileId}`;
  if (d.kind === "team") return `the ${cfg.teams.find((t) => t.key === d.teamKey)?.name ?? d.teamKey} team`;
  if (d.kind === "role") return `everyone with the ${d.role} role`;
  if (d.kind === "duty") return "the duty person";
  return "the queue";
}

/** First available person out of a list, spreading load across a team. */
async function pick(ids: number[], date: string, steps: string[], spread: boolean): Promise<Person | null> {
  const load = spread ? await openLoad(ids) : new Map<number, number>();
  const order = spread ? [...ids].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0)) : ids;
  for (const id of order) {
    const p = await settle(id, date, steps);
    if (p) return p;
  }
  return null;
}

export async function jobManagerOf(jobId: number | null | undefined) {
  if (!jobId) return null;
  const [row] = await db.select().from(schema.jobManagers).where(eq(schema.jobManagers.jobId, jobId));
  return row?.profileId ?? null;
}

export async function resolveRoute(
  cfg: PhoneConfig,
  type: CallType,
  opts: { jobId?: number | null; now?: Date; dest?: Destination | null; exclude?: number[] } = {},
): Promise<Route> {
  const date = localDate(opts.now ?? new Date());
  const steps: string[] = [];
  const r = ruleFor(cfg, type);
  const done = (p: Person, via: string): Route => {
    steps.push(`Owner: ${p.name}.`);
    return { ownerProfileId: p.id, ownerName: p.name, queueKey: cfg.defaultQueue, steps, via };
  };
  const exclude = new Set(opts.exclude ?? []);

  if (!opts.dest && type === "existing_job" && cfg.jobManagerFirst && opts.jobId) {
    const mgr = await jobManagerOf(opts.jobId);
    if (mgr && !exclude.has(mgr)) {
      steps.push("The job has a manager, tried first.");
      const p = await settle(mgr, date, steps);
      if (p) return done(p, "job manager");
    } else steps.push("The job has no manager set.");
  }

  const dest = opts.dest ?? r.dest;
  const names = await peopleById(dest.kind === "profile" ? [dest.profileId] : []);
  steps.push(`Rule: goes to ${destLabel(cfg, dest, new Map([...names].map(([k, v]) => [k, v.name])))}.`);
  const ids = (await membersOf(cfg, dest, steps)).filter((id) => !exclude.has(id));
  const first = await pick(ids, date, steps, dest.kind === "team" || dest.kind === "role");
  if (first) return done(first, destLabel(cfg, dest, new Map([[first.id, first.name]])));

  if (!opts.dest && r.backupProfileId && !exclude.has(r.backupProfileId)) {
    steps.push("Nobody there is available, trying the backup.");
    const b = await settle(r.backupProfileId, date, steps);
    if (b) return done(b, "backup");
  }
  if (cfg.dutyProfileId && !exclude.has(cfg.dutyProfileId) && dest.kind !== "duty") {
    steps.push("Trying the duty person.");
    const d = await settle(cfg.dutyProfileId, date, steps);
    if (d) return done(d, "duty person");
  }
  const q = cfg.teams.find((t) => t.key === cfg.defaultQueue)?.name ?? cfg.defaultQueue;
  steps.push(`Nobody available. It waits unowned in the ${q} queue.`);
  return { ownerProfileId: null, ownerName: "", queueKey: cfg.defaultQueue, steps, via: "queue" };
}

/** Everyone who should see unowned work in the queue: its team, or all office staff when the team is empty. */
export async function queueWatchers(cfg: PhoneConfig): Promise<number[]> {
  const t = cfg.teams.find((x) => x.key === cfg.defaultQueue);
  if (t?.memberIds.length) return t.memberIds;
  const rows = await db
    .select({ id: schema.profiles.id })
    .from(schema.profiles)
    .where(and(inArray(schema.profiles.role, ["admin", "office"]), eq(schema.profiles.active, true), isNull(schema.profiles.archivedAt)));
  return rows.map((r) => r.id);
}
