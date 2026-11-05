import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { audit } from "./calls";
import { CALL_TYPE_LABELS, deadlineFrom, inOfficeHours, nextOpen, ruleFor, type CallType, type PhoneConfig } from "./config";
import { notifyPhone } from "./notify";
import { personOf, resolveRoute, type Route } from "./routing";

/* ---------------------------------------------------------------------------
 * Follow-ups: work a call left for a person (Retell, 5 Nov).
 *
 * Made only when something still needs doing. One accountable owner at a
 * time. States new → assigned → in_progress → resolved, kept apart from
 * whether anyone has read the notification.
 *
 * Moving work to someone else (claim, assign, reassign, leave cover) keeps
 * its deadline and its history, tells the new owner, and writes an audit line.
 * ------------------------------------------------------------------------- */

export type Followup = typeof schema.phoneFollowups.$inferSelect;
export type StaffActor = { name: string; role: string; profileId: number | null };

export const FOLLOWUP_STATES = ["new", "assigned", "in_progress", "resolved"] as const;

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function followupPath(id: number) {
  return `/phone-calls?followup=${id}`;
}

export async function followupById(id: number) {
  const [row] = await db.select().from(schema.phoneFollowups).where(eq(schema.phoneFollowups.id, id));
  return row ?? null;
}

/**
 * Make the follow-up for a call, or hand back the one already made with the
 * same key (a retried webhook, two tools asking for the same thing).
 */
export async function createFollowup(
  cfg: PhoneConfig,
  args: {
    dedupeKey: string;
    callType: CallType;
    title: string;
    detail: string;
    callId?: number | null;
    jobId?: number | null;
    contactId?: number | null;
    priority?: "normal" | "high" | "urgent";
    callerLine?: string;
    now?: Date;
  },
): Promise<{ row: Followup; created: boolean; route: Route | null }> {
  const [prior] = await db.select().from(schema.phoneFollowups).where(eq(schema.phoneFollowups.dedupeKey, args.dedupeKey));
  if (prior) return { row: prior, created: false, route: null };

  const now = args.now ?? new Date();
  const rule = ruleFor(cfg, args.callType);
  const priority = args.priority ?? rule.priority;
  const urgent = priority === "urgent";
  const route = await resolveRoute(cfg, args.callType, { jobId: args.jobId ?? null, now });
  const dueAt = deadlineFrom(cfg, rule.deadlineMins, now, urgent);

  const [row] = await db
    .insert(schema.phoneFollowups)
    .values({
      callId: args.callId ?? null,
      jobId: args.jobId ?? null,
      contactId: args.contactId ?? null,
      callType: args.callType,
      title: short(args.title, 200),
      detail: args.detail.slice(0, 4000),
      priority,
      status: route.ownerProfileId ? "assigned" : "new",
      ownerProfileId: route.ownerProfileId,
      ownerName: route.ownerName,
      queueKey: route.queueKey,
      routedVia: route.via,
      dueAt,
      dedupeKey: args.dedupeKey,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const [again] = await db.select().from(schema.phoneFollowups).where(eq(schema.phoneFollowups.dedupeKey, args.dedupeKey));
    return { row: again!, created: false, route: null };
  }

  await audit("phone_followup", row.id, "followup_created", `${CALL_TYPE_LABELS[args.callType]}: ${row.title}. ${route.steps.join(" ")}`, { name: "AI phone agent", role: "system" }, row.jobId);

  const afterHours = !urgent && !inOfficeHours(cfg, now);
  const when = afterHours ? ` Office closed: the clock starts ${sayWhen(nextOpen(cfg, now))}.` : "";
  await notifyPhone(
    cfg,
    route.ownerProfileId,
    {
      kind: urgent ? "phone_urgent" : "phone_followup",
      reason: urgent ? "urgent" : "new_owner",
      title: short(`${urgent ? "URGENT call: " : "Call follow-up: "}${row.title}`, 140),
      body: short(`${args.callerLine ? `${args.callerLine}. ` : ""}Due ${sayWhen(dueAt)}.${route.ownerProfileId ? "" : " Nobody owns it yet, claim it."}${when}`, 300),
      path: followupPath(row.id),
      callId: row.callId,
      followupId: row.id,
      jobId: row.jobId,
      urgent,
    },
    rule.channels,
  );
  return { row, created: true, route };
}

export function sayWhen(d: Date | null | undefined) {
  if (!d) return "no deadline";
  return d.toLocaleString("en-AU", { timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

async function setOwner(fu: Followup, profileId: number, status: "assigned" | "in_progress", by: StaffActor, action: string, note: string) {
  const p = await personOf(profileId);
  if (!p || p.archived || !p.active) throw new Error("That person can't take work right now.");
  if (p.role !== "admin" && p.role !== "office") throw new Error("Only office staff can own phone follow-ups.");
  const before = fu.ownerName || "nobody";
  // Deadline, history and escalation level stay as they were: moving work never resets its clock.
  const [row] = await db
    .update(schema.phoneFollowups)
    .set({ ownerProfileId: p.id, ownerName: p.name, status, routedVia: action === "claimed" ? "claimed" : `${action} by ${by.name}`, updatedAt: new Date() })
    .where(eq(schema.phoneFollowups.id, fu.id))
    .returning();
  await audit("phone_followup", fu.id, `followup_${action}`, `${before} → ${p.name}${note ? `. ${note}` : ""}`, by, fu.jobId);
  return { row: row!, person: p };
}

/** Take unowned (or anyone's, with reassign permission) work for yourself. */
export async function claimFollowup(cfg: PhoneConfig, id: number, by: StaffActor & { profileId: number }) {
  const fu = await followupById(id);
  if (!fu) throw new Error("Follow-up not found.");
  if (fu.status === "resolved") throw new Error("That one is already resolved.");
  if (fu.ownerProfileId === by.profileId) return fu;
  const { row } = await setOwner(fu, by.profileId, "in_progress", by, "claimed", fu.ownerProfileId ? `Taken over from ${fu.ownerName}` : "");
  if (fu.ownerProfileId) await tellOldOwner(cfg, fu, `${by.name} has taken this over.`);
  return row;
}

/** Give it to someone else. Their deadline is the one it already had. */
export async function assignFollowup(cfg: PhoneConfig, id: number, toProfileId: number, by: StaffActor, note = "") {
  const fu = await followupById(id);
  if (!fu) throw new Error("Follow-up not found.");
  if (fu.status === "resolved") throw new Error("That one is already resolved.");
  if (fu.ownerProfileId === toProfileId) return fu;
  const { row } = await setOwner(fu, toProfileId, "assigned", by, fu.ownerProfileId ? "reassigned" : "assigned", note);
  const rule = ruleFor(cfg, fu.callType as CallType);
  await notifyPhone(
    cfg,
    toProfileId,
    {
      kind: fu.priority === "urgent" ? "phone_urgent" : "phone_followup",
      reason: "new_owner",
      title: short(`${by.name} passed you a call follow-up: ${fu.title}`, 140),
      body: short(`Due ${sayWhen(fu.dueAt)}.${note ? ` ${note}` : ""}`, 300),
      path: followupPath(fu.id),
      callId: fu.callId,
      followupId: fu.id,
      jobId: fu.jobId,
      urgent: fu.priority === "urgent",
    },
    rule.channels,
  );
  if (fu.ownerProfileId && fu.ownerProfileId !== by.profileId) await tellOldOwner(cfg, fu, `${by.name} passed it to ${row.ownerName}.`);
  return row;
}

async function tellOldOwner(cfg: PhoneConfig, fu: Followup, line: string) {
  if (!fu.ownerProfileId) return;
  await notifyPhone(cfg, fu.ownerProfileId, { kind: "phone_followup", reason: "new_owner", title: short(`No longer yours: ${fu.title}`, 140), body: line, path: followupPath(fu.id), followupId: fu.id, callId: fu.callId, jobId: fu.jobId }, ["in_app"]);
}

export async function startFollowup(id: number, by: StaffActor) {
  const fu = await followupById(id);
  if (!fu) throw new Error("Follow-up not found.");
  if (fu.status === "resolved") throw new Error("That one is already resolved.");
  if (fu.status === "in_progress") return fu;
  const [row] = await db.update(schema.phoneFollowups).set({ status: "in_progress", updatedAt: new Date() }).where(eq(schema.phoneFollowups.id, id)).returning();
  await audit("phone_followup", id, "followup_started", `Started by ${by.name}`, by, fu.jobId);
  return row!;
}

export async function resolveFollowup(id: number, by: StaffActor, resolution: string) {
  const fu = await followupById(id);
  if (!fu) throw new Error("Follow-up not found.");
  if (fu.status === "resolved") return fu;
  const text = resolution.trim();
  if (text.length < 3) throw new Error("Say what was done, at least a few words.");
  const [row] = await db
    .update(schema.phoneFollowups)
    .set({ status: "resolved", resolvedAt: new Date(), resolvedByName: by.name, resolution: text.slice(0, 2000), updatedAt: new Date() })
    .where(eq(schema.phoneFollowups.id, id))
    .returning();
  await audit("phone_followup", id, "followup_resolved", text, by, fu.jobId);
  if (fu.jobId) {
    await db.insert(schema.activityLog).values({ jobId: fu.jobId, entityType: "job", entityId: fu.jobId, action: "phone_followup_resolved", detail: `Phone follow-up done: ${fu.title}. ${text}`.slice(0, 4000), actorName: by.name, actorRole: by.role });
  }
  return row!;
}

/** Reopen a resolved one: it goes back to its owner with its old deadline. */
export async function reopenFollowup(id: number, by: StaffActor, why: string) {
  const fu = await followupById(id);
  if (!fu) throw new Error("Follow-up not found.");
  if (fu.status !== "resolved") return fu;
  const [row] = await db
    .update(schema.phoneFollowups)
    .set({ status: fu.ownerProfileId ? "assigned" : "new", resolvedAt: null, resolvedByName: null, updatedAt: new Date() })
    .where(eq(schema.phoneFollowups.id, id))
    .returning();
  await audit("phone_followup", id, "followup_reopened", why || "Reopened", by, fu.jobId);
  return row!;
}

/**
 * Leave cover or a delegation was just set: hand that person's open work to
 * the cover, keeping every deadline. Returns how many moved.
 */
export async function moveOpenWork(cfg: PhoneConfig, fromProfileId: number, toProfileId: number, by: StaffActor, why: string) {
  const open = await db
    .select()
    .from(schema.phoneFollowups)
    .where(and(eq(schema.phoneFollowups.ownerProfileId, fromProfileId), ne(schema.phoneFollowups.status, "resolved")));
  let moved = 0;
  for (const fu of open) {
    await assignFollowup(cfg, fu.id, toProfileId, by, why);
    moved++;
  }
  return moved;
}

export async function openFollowups(filter: { ownerProfileId?: number | null; status?: string[]; jobId?: number; contactId?: number; limit?: number } = {}) {
  const conds = [];
  if (filter.ownerProfileId !== undefined) conds.push(filter.ownerProfileId === null ? eq(schema.phoneFollowups.status, "new") : eq(schema.phoneFollowups.ownerProfileId, filter.ownerProfileId));
  if (filter.status?.length) conds.push(inArray(schema.phoneFollowups.status, filter.status));
  if (filter.jobId) conds.push(eq(schema.phoneFollowups.jobId, filter.jobId));
  if (filter.contactId) conds.push(eq(schema.phoneFollowups.contactId, filter.contactId));
  return db
    .select()
    .from(schema.phoneFollowups)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.phoneFollowups.id))
    .limit(filter.limit ?? 200);
}
