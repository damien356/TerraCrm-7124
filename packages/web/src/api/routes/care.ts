import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { CARE_FLOORS, CARE_FLOOR_LABELS, FIBRE_LABELS, JOB_FIBRES, PILES, PILE_LABELS, SCHEDULE_LABELS, codeKind, isCareFloor, scheduleKeyFor, type Fibre, type Pile } from "../lib/care-codes";
import { careLastRun, careRunOnce, careTicking } from "../lib/care-boot";
import { careSettings, careTemplates, enrolJob, homeownerFor, inactiveCodes, jobCareFacts, parseMemberFloors, planInputFor, sendCareEmail, setCareOn, setWoolRanges, slowGroups } from "../lib/care-engine";
import { holidayDue, nextEmail, simulate } from "../lib/care-plan";
import { careBody, renderCareEmail } from "../lib/care-render";
import { CARE_TEMPLATE_MAP } from "../lib/care-templates";
import { fillMergeFields } from "../lib/email";
import { parseFloors } from "../lib/care-detect";
import { bad } from "../lib/variations";

/* ---------------------------------------------------------------------------
 * The Care page (/marketing/care) and the care card on a job. Section 18.37.
 *
 * Reading is Admin and Office. Switching the engine, the wool ranges and the
 * email copy are Admin only, like the other marketing settings that change
 * what customers get.
 * ------------------------------------------------------------------------- */

const DAY = 86_400_000;
const fibreEnum = z.enum(JOB_FIBRES);
const pileEnum = z.enum(PILES);

const titleOf = (code: string) => CARE_TEMPLATE_MAP.get(code)?.title ?? code;
const nameOf = (c: { firstName: string; lastName: string } | null | undefined) => (c ? `${c.firstName} ${c.lastName}`.trim() : "");

const SAMPLE_FIRST = "Sarah";

/** The finished email for the preview: sample name, no pixel, and a dead unsubscribe link. */
function previewOf(subject: string, body: string, flags: { fibre: string; pile: string }, resend: boolean) {
  const fields = { first_name: SAMPLE_FIRST };
  const text = fillMergeFields(careBody(body, flags, resend), fields);
  const out = renderCareEmail(text, { unsubUrl: "#unsubscribe" });
  return { subject: fillMergeFields(subject, fields), html: out.html, text: out.text };
}

export const care = {
  /** Everything the Care page shows: the switch, who is in, what they are up to, opens and unsubscribes. */
  report: staffOnly.handler(async () => {
    const now = new Date();
    const s = await careSettings();
    const templates = await careTemplates();
    const inactive = inactiveCodes(templates);
    const slow = await slowGroups(now);

    const members = await db
      .select({ m: schema.careMembers, c: { firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, email: schema.contacts.email } })
      .from(schema.careMembers)
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.careMembers.contactId))
      .orderBy(desc(schema.careMembers.startedAt));
    const sends = members.length ? await db.select().from(schema.careSends).where(inArray(schema.careSends.memberId, members.map((x) => x.m.id))) : [];
    const byMember = new Map<number, (typeof sends)[number][]>();
    for (const r of sends) byMember.set(r.memberId, [...(byMember.get(r.memberId) ?? []), r]);

    const rows = members.map(({ m, c }) => {
      const mine = (byMember.get(m.id) ?? []).sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0));
      const sent = mine.filter((r) => r.status === "sent");
      const input = planInputFor(m, mine, now, inactive);
      const groupSlow = [...new Set(parseMemberFloors(m.floors).map((f) => scheduleKeyFor(f.floor, m.landlord)))].some((k) => slow.has(k));
      const next = m.status === "active" ? (holidayDue({ ...input, slow: groupSlow }) ?? nextEmail({ ...input, slow: groupSlow })) : null;
      const last = sent[sent.length - 1];
      return {
        id: m.id,
        contactId: m.contactId,
        name: nameOf(c),
        email: c.email ?? "",
        status: m.status,
        stopReason: m.stopReason,
        floors: parseMemberFloors(m.floors).map((f) => ({ floor: f.floor, label: CARE_FLOOR_LABELS[f.floor], jobId: f.jobId, startedAt: f.startedAt })),
        fibre: m.fibre,
        pile: m.pile,
        landlord: m.landlord,
        startedAt: m.startedAt.getTime(),
        sent: sent.length,
        opened: sent.filter((r) => r.openedAt).length,
        resent: sent.filter((r) => r.resentAt && r.resendSendId).length,
        last: last ? { code: last.code, title: titleOf(last.code), at: last.sentAt?.getTime() ?? 0, opened: !!last.openedAt } : null,
        next: next ? { code: next.code, title: titleOf(next.code), kind: next.kind, dueAt: next.dueAt.getTime() } : null,
        slow: groupSlow,
      };
    });

    const totals = {
      members: rows.length,
      active: rows.filter((r) => r.status === "active").length,
      unsubscribed: rows.filter((r) => r.status === "unsubscribed").length,
      stopped: rows.filter((r) => r.status === "stopped").length,
      sent: sends.filter((r) => r.status === "sent").length,
      opened: sends.filter((r) => r.status === "sent" && r.openedAt).length,
      sent30: sends.filter((r) => r.status === "sent" && r.sentAt && now.getTime() - r.sentAt.getTime() < 30 * DAY).length,
    };

    /* Per email: how often it went, how often it was opened. */
    const perCode = new Map<string, { sent: number; opened: number }>();
    for (const r of sends) {
      if (r.status !== "sent") continue;
      const x = perCode.get(r.code) ?? { sent: 0, opened: 0 };
      x.sent++;
      if (r.openedAt) x.opened++;
      perCode.set(r.code, x);
    }

    /* Jobs that need a look: waiting on the wool answer, or skipped for a reason the office can fix. */
    const attention = await db
      .select({
        id: schema.jobs.id,
        number: schema.jobs.number,
        displayNumber: schema.jobs.displayNumber,
        title: schema.jobs.title,
        careState: schema.jobs.careState,
        careNote: schema.jobs.careNote,
        completedAt: schema.jobs.completedAt,
        updatedAt: schema.jobs.updatedAt,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
      })
      .from(schema.jobs)
      .leftJoin(schema.contacts, eq(schema.contacts.id, schema.jobs.contactId))
      .where(inArray(schema.jobs.careState, ["waiting_wool", "skipped"]))
      .orderBy(desc(schema.jobs.updatedAt))
      .limit(100);

    return {
      settings: { on: s.on, startedAt: s.startedAt?.getTime() ?? null, woolRanges: s.woolRanges, ticking: careTicking(), lastRun: careLastRun() ? { at: careLastRun()!.at.getTime(), error: careLastRun()!.error ?? null } : null },
      totals,
      members: rows,
      perCode: [...perCode.entries()].map(([code, v]) => ({ code, title: titleOf(code), ...v })).sort((a, b) => b.sent - a.sent),
      attention: attention.map(({ firstName, lastName, ...j }) => ({
        ...j,
        client: `${firstName ?? ""} ${lastName ?? ""}`.trim(),
        ref: j.displayNumber ?? String(j.number),
        completedAt: j.completedAt?.getTime() ?? null,
        updatedAt: j.updatedAt.getTime(),
      })),
      slowGroups: [...slow].map((k) => SCHEDULE_LABELS[k]),
    };
  }),

  /** One person: every email so far and the plan for the next 12 months. */
  member: staffOnly.input(z.object({ memberId: z.number().int() })).handler(async ({ input }) => {
    const [m] = await db.select().from(schema.careMembers).where(eq(schema.careMembers.id, input.memberId));
    if (!m) throw bad("Not in the care series.");
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, m.contactId));
    const rows = await db.select().from(schema.careSends).where(eq(schema.careSends.memberId, m.id)).orderBy(desc(schema.careSends.id));
    const templates = await careTemplates();
    const now = new Date();
    const plan = m.status === "active" ? simulate(planInputFor(m, rows, now, inactiveCodes(templates)), new Date(now.getTime() + 365 * DAY), 40) : [];
    return {
      id: m.id,
      name: nameOf(c),
      email: c?.email ?? "",
      contactId: m.contactId,
      status: m.status,
      stopReason: m.stopReason,
      fibre: m.fibre,
      pile: m.pile,
      landlord: m.landlord,
      floors: parseMemberFloors(m.floors).map((f) => ({ ...f, label: CARE_FLOOR_LABELS[f.floor] })),
      history: rows.map((r) => ({
        id: r.id,
        code: r.code,
        title: titleOf(r.code),
        kind: r.kind,
        status: r.status,
        sentAt: r.sentAt?.getTime() ?? null,
        openedAt: r.openedAt?.getTime() ?? null,
        resentAt: r.resentAt?.getTime() ?? null,
        resent: !!r.resendSendId,
        note: r.note,
      })),
      plan: plan.map((p) => ({ code: p.code, title: titleOf(p.code), kind: p.kind, dueAt: p.dueAt.getTime() })),
    };
  }),

  /** Take someone out of the series, or put them back where they left off. Never after an unsubscribe. */
  setMemberStatus: staffOnly.input(z.object({ memberId: z.number().int(), active: z.boolean() })).handler(async ({ input, context }) => {
    const [m] = await db.select().from(schema.careMembers).where(eq(schema.careMembers.id, input.memberId));
    if (!m) throw bad("Not in the care series.");
    if (m.status === "unsubscribed") throw bad("They unsubscribed. Only they can come back, by asking.");
    await db
      .update(schema.careMembers)
      .set({ status: input.active ? "active" : "stopped", stopReason: input.active ? "" : `Taken out by ${context.actor.name}`, updatedAt: new Date() })
      .where(eq(schema.careMembers.id, m.id));
    return { ok: true as const };
  }),

  setOn: adminOnly.input(z.object({ on: z.boolean() })).handler(async ({ input }) => {
    const s = await setCareOn(input.on);
    return { on: s.on, startedAt: s.startedAt?.getTime() ?? null };
  }),

  /** Runs the engine once now. Only on the published server, so a sandbox can never send. */
  runNow: adminOnly.handler(async () => {
    if (!careTicking()) throw bad("The care engine only runs on the live site.");
    return careRunOnce();
  }),

  setWoolRanges: adminOnly.input(z.object({ ranges: z.array(z.string().max(80)).max(200) })).handler(async ({ input }) => ({ ranges: await setWoolRanges(input.ranges) })),

  /* ---- Templates ---- */

  templates: staffOnly.handler(async () => {
    const live = await careTemplates();
    return [...live.values()].map((t) => {
      const base = CARE_TEMPLATE_MAP.get(t.code)!;
      return { ...t, kind: codeKind(t.code), baseSubject: base.subject, baseBody: base.body };
    });
  }),

  saveTemplate: adminOnly
    .input(z.object({ code: z.string().max(10), subject: z.string().max(200), body: z.string().max(20_000), active: z.boolean() }))
    .handler(async ({ input }) => {
      const base = CARE_TEMPLATE_MAP.get(input.code);
      if (!base) throw bad("No care email with that code.");
      if (!input.subject.trim()) throw bad("The subject cannot be empty.");
      if (!input.body.trim()) throw bad("The email cannot be empty.");
      /* Same as the starting copy: store only the switch, so a later fix to the copy still flows through. */
      const subject = input.subject.trim() === base.subject ? "" : input.subject.trim();
      const body = input.body.trim() === base.body.trim() ? "" : input.body.replace(/\r\n/g, "\n").trim();
      await db
        .insert(schema.careTemplates)
        .values({ code: input.code, subject, body, active: input.active, updatedAt: new Date() })
        .onConflictDoUpdate({ target: schema.careTemplates.code, set: { subject, body, active: input.active, updatedAt: new Date() } });
      return { ok: true as const };
    }),

  resetTemplate: adminOnly.input(z.object({ code: z.string().max(10) })).handler(async ({ input }) => {
    const [had] = await db.select().from(schema.careTemplates).where(eq(schema.careTemplates.code, input.code));
    if (had) {
      await db.update(schema.careTemplates).set({ subject: "", body: "", updatedAt: new Date() }).where(eq(schema.careTemplates.code, input.code));
    }
    return { ok: true as const };
  }),

  preview: staffOnly
    .input(
      z.object({
        code: z.string().max(10),
        subject: z.string().max(200).optional(),
        body: z.string().max(20_000).optional(),
        fibre: z.string().max(20).default(""),
        pile: z.string().max(20).default(""),
        resend: z.boolean().default(false),
      }),
    )
    .handler(async ({ input }) => {
      const t = (await careTemplates()).get(input.code);
      if (!t) throw bad("No care email with that code.");
      return previewOf(input.subject ?? t.subject, input.body ?? t.body, { fibre: input.fibre, pile: input.pile }, input.resend);
    }),

  /** Sends the email to the person signed in, as it would go. Nothing is recorded against anyone. */
  sendTest: adminOnly
    .input(z.object({ code: z.string().max(10), fibre: z.string().max(20).default(""), pile: z.string().max(20).default("") }))
    .handler(async ({ input, context }) => {
      const templates = await careTemplates();
      if (!templates.get(input.code)) throw bad("No care email with that code.");
      const to = context.actor.email;
      if (!to) throw bad("Your login has no email address.");
      const nowD = new Date();
      const contact = { id: -1, firstName: context.actor.name.split(" ")[0] || SAMPLE_FIRST, lastName: "", email: to } as typeof schema.contacts.$inferSelect;
      const member = { id: -1, contactId: -1, fibre: input.fibre, pile: input.pile, lastJobId: null } as unknown as typeof schema.careMembers.$inferSelect;
      const r = await sendCareEmail({ member, contact, item: { code: input.code, kind: codeKind(input.code), dueAt: nowD, jobId: null }, templates, test: { to } });
      if (!r.ok) throw bad(`Not sent: ${r.reason}`);
      return { ok: true as const, to };
    }),

  /* ---- The job ---- */

  /** The care card on a job: who would get it, what went down, and where it is up to. */
  job: staffOnly.input(z.object({ jobId: z.number().int() })).handler(async ({ input }) => {
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
    if (!job) throw bad("Job not found.");
    const [st] = job.statusId
      ? await db.select({ stage: schema.jobStatuses.stage, name: schema.jobStatuses.name }).from(schema.jobStatuses).where(eq(schema.jobStatuses.id, job.statusId))
      : [];
    const completed = !!st && (st.stage === "complete" || (st.stage === "closed" && st.name.trim().toLowerCase() === "paid"));
    const s = await careSettings();
    const facts = await jobCareFacts(job, s.woolRanges);
    const pick = await homeownerFor(job);
    let person: { contactId: number; name: string; email: string; landlord: boolean } | null = null;
    let member: { id: number; status: string; sent: number } | null = null;
    if (pick.contactId) {
      const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, pick.contactId));
      person = { contactId: pick.contactId, name: nameOf(c), email: c?.email ?? "", landlord: pick.landlord };
      const [m] = await db.select().from(schema.careMembers).where(eq(schema.careMembers.contactId, pick.contactId));
      if (m) {
        const [n] = await db.select({ n: sql<number>`count(*)` }).from(schema.careSends).where(and(eq(schema.careSends.memberId, m.id), eq(schema.careSends.status, "sent")));
        member = { id: m.id, status: m.status, sent: Number(n?.n ?? 0) };
      }
    }
    return {
      engineOn: s.on,
      completed,
      callback: job.parentJobId != null,
      careState: job.careState,
      careNote: job.careNote,
      floorsSet: parseFloors(job.careFloors),
      floors: facts.floors,
      floorsFrom: facts.floorsFrom,
      hasCarpet: facts.hasCarpet,
      fibre: job.fibre,
      detectedFibre: facts.fibre,
      fibreFrom: facts.fibreFrom,
      pile: job.pile,
      detectedPile: facts.pile,
      careLandlord: job.careLandlord,
      person,
      noPersonReason: pick.contactId === null ? pick.reason : null,
      member,
      options: {
        floors: CARE_FLOORS.map((f) => ({ value: f, label: CARE_FLOOR_LABELS[f] })),
        fibres: JOB_FIBRES.map((f) => ({ value: f, label: FIBRE_LABELS[f as Fibre] })),
        piles: PILES.map((p) => ({ value: p, label: PILE_LABELS[p as Pile] })),
      },
    };
  }),

  /** The one-tap wool question. The job goes into the series straight away once answered. */
  woolAnswer: staffOnly
    .input(z.object({ jobId: z.number().int(), answer: z.enum(["wool", "wool_blend", "not_wool"]) }))
    .handler(async ({ input }) => {
      const [job] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
      if (!job) throw bad("Job not found.");
      await db.update(schema.jobs).set({ fibre: input.answer, updatedAt: new Date() }).where(eq(schema.jobs.id, input.jobId));
      await db
        .update(schema.alerts)
        .set({ readAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.alerts.jobId, input.jobId), eq(schema.alerts.kind, "care_wool"), sql`${schema.alerts.readAt} is null`));
      const r = await enrolJob(input.jobId, { notify: false });
      return r;
    }),

  /** What went down, the fibre, the pile and landlord, set by the office. Blank floors goes back to working it out. */
  setJob: staffOnly
    .input(
      z.object({
        jobId: z.number().int(),
        floors: z.array(z.string()).nullable().optional(),
        fibre: z.union([fibreEnum, z.literal("")]).optional(),
        pile: z.union([pileEnum, z.literal("")]).optional(),
        landlord: z.boolean().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
      if (!job) throw bad("Job not found.");
      const set: Partial<typeof schema.jobs.$inferInsert> = { updatedAt: new Date() };
      if (input.floors !== undefined) set.careFloors = input.floors === null ? "" : JSON.stringify(CARE_FLOORS.filter((f) => input.floors!.includes(f) && isCareFloor(f)));
      if (input.fibre !== undefined) set.fibre = input.fibre;
      if (input.pile !== undefined) set.pile = input.pile;
      if (input.landlord !== undefined) set.careLandlord = input.landlord;
      await db.update(schema.jobs).set(set).where(eq(schema.jobs.id, input.jobId));
      return { ok: true as const };
    }),

  /** Looks at the job again after the office fixed what stopped it. Only once the job is completed. */
  retryJob: staffOnly.input(z.object({ jobId: z.number().int() })).handler(async ({ input }) => {
    const [job] = await db
      .select({ id: schema.jobs.id, stage: schema.jobStatuses.stage, status: schema.jobStatuses.name })
      .from(schema.jobs)
      .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
      .where(eq(schema.jobs.id, input.jobId));
    if (!job) throw bad("Job not found.");
    const completed = job.stage === "complete" || (job.stage === "closed" && (job.status ?? "").toLowerCase() === "paid");
    if (!completed) throw bad("The care emails start when the job is Completed.");
    return enrolJob(input.jobId);
  }),
};
