import { jobNumberSql } from "./job-ref";
import { and, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { todayLocal } from "./local-date";
import { openBlockingFlags } from "./swms-checks";

/* ---------------------------------------------------------------------------
 * When a SWMS is needed, and whether it has been done.
 *
 * Required when the job says so, or (with no job override) when the client
 * or the company is flagged. Done means THIS worker signed one for THIS job
 * on THIS Gold Coast day. Each worker signs their own, and each day on a
 * multi-day job is re-confirmed and signed again.
 * ------------------------------------------------------------------------- */

export type SwmsSource = "job" | "company" | "contact" | null;

/** The SQL that decides it, so lists can filter without a round trip per job. */
export const swmsRequiredSql = sql<number>`coalesce(${schema.jobs.requiresSwms}, case when coalesce(${schema.contacts.requiresSwms}, 0) = 1 or coalesce(${schema.companies.requiresSwms}, 0) = 1 then 1 else 0 end)`;

export async function swmsRequirement(jobIds: number[]) {
  const out = new Map<number, { required: boolean; source: SwmsSource; override: boolean | null }>();
  if (jobIds.length === 0) return out;
  const rows = await db
    .select({
      id: schema.jobs.id,
      override: schema.jobs.requiresSwms,
      contact: schema.contacts.requiresSwms,
      company: schema.companies.requiresSwms,
    })
    .from(schema.jobs)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.jobs.contactId))
    .leftJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
    .where(inArray(schema.jobs.id, [...new Set(jobIds)]));
  for (const r of rows) {
    if (r.override !== null && r.override !== undefined) {
      out.set(r.id, { required: Boolean(r.override), source: "job", override: Boolean(r.override) });
    } else if (r.company) out.set(r.id, { required: true, source: "company", override: null });
    else if (r.contact) out.set(r.id, { required: true, source: "contact", override: null });
    else out.set(r.id, { required: false, source: null, override: null });
  }
  return out;
}

/** Jobs this installer has signed a SWMS for on a given day. */
export async function swmsSignedJobs(installerId: number, jobIds: number[], date = todayLocal()) {
  if (jobIds.length === 0) return new Set<number>();
  const rows = await db
    .select({ jobId: schema.swmsRecords.jobId })
    .from(schema.swmsRecords)
    .where(
      and(
        eq(schema.swmsRecords.installerId, installerId),
        eq(schema.swmsRecords.workDate, date),
        inArray(schema.swmsRecords.jobId, [...new Set(jobIds)]),
      ),
    );
  return new Set(rows.map((r) => r.jobId));
}

/** For task cards: true where a SWMS is required today and this worker hasn't signed it. */
export async function swmsNeededFor(installerId: number, jobIds: number[]) {
  const req = await swmsRequirement(jobIds);
  const requiredIds = [...req.entries()].filter(([, v]) => v.required).map(([k]) => k);
  const signed = await swmsSignedJobs(installerId, requiredIds);
  const out = new Map<number, { required: boolean; signedToday: boolean }>();
  for (const id of jobIds) {
    const required = req.get(id)?.required ?? false;
    out.set(id, { required, signedToday: required ? signed.has(id) : false });
  }
  return out;
}

/**
 * The server-side gate for Start and Complete. The phone shows the same rule,
 * but this is the one that counts.
 */
export async function assertSwmsDone(jobId: number, installerId: number, action: "start" | "finish") {
  // A red card that stops the job holds Start for everyone on it, signed or not.
  if (action === "start") {
    const [stop] = await openBlockingFlags(jobId);
    if (stop) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: `Red card on this job: "${stop.question}". The office has been told. Do not start until they call you.`,
        data: { swmsBlocked: true, jobId },
      });
    }
  }
  const req = (await swmsRequirement([jobId])).get(jobId);
  if (!req?.required) return;
  const signed = await swmsSignedJobs(installerId, [jobId]);
  if (signed.has(jobId)) return;
  throw new ORPCError("PRECONDITION_FAILED", {
    message: `SWMS needed. Do today's SWMS for this job before you ${action}.`,
    data: { swmsNeeded: true, jobId },
  });
}

/* ------------------------------ the board ------------------------------ */

export type BoardRow = {
  jobId: number;
  jobNumber: number | string;
  jobTitle: string;
  siteAddress: string;
  date: string;
  installerId: number;
  installerName: string;
  taskTitles: string[];
  record: { id: number; signedAt: Date; signedName: string; kind: string } | null;
};

/**
 * Every worker-day on a SWMS job between two dates: who is booked, and
 * whether their SWMS for that day is signed. Ops reads this at a glance.
 */
export async function swmsBoard(from: string, to: string): Promise<BoardRow[]> {
  const tasks = await db
    .select({
      id: schema.jobTasks.id,
      jobId: schema.jobTasks.jobId,
      title: schema.jobTasks.title,
      scheduledDate: schema.jobTasks.scheduledDate,
      a: schema.jobTasks.assignedInstallerId,
      b: schema.jobTasks.secondInstallerId,
      jobNumber: jobNumberSql,
      jobTitle: schema.jobs.title,
      address: schema.sites.address,
      suburb: schema.sites.suburb,
    })
    .from(schema.jobTasks)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.jobs.contactId))
    .leftJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
    .where(
      and(
        sql`${swmsRequiredSql} = 1`,
        inArray(schema.jobTasks.status, ["assigned", "in_progress", "complete"]),
        or(
          and(gte(schema.jobTasks.scheduledDate, from), lte(schema.jobTasks.scheduledDate, to)),
          sql`exists (select 1 from task_days d where d.task_id = ${schema.jobTasks.id} and d.date >= ${from} and d.date <= ${to})`,
        ),
      ),
    );
  if (tasks.length === 0) return [];

  const ids = tasks.map((t) => t.id);
  const days = await db
    .select({ taskId: schema.taskDays.taskId, date: schema.taskDays.date, installerId: schema.taskDays.installerId })
    .from(schema.taskDays)
    .where(and(inArray(schema.taskDays.taskId, ids), ne(schema.taskDays.status, "cancelled")));
  const daysByTask = new Map<number, typeof days>();
  for (const d of days) {
    if (!daysByTask.has(d.taskId)) daysByTask.set(d.taskId, []);
    daysByTask.get(d.taskId)!.push(d);
  }

  // job|date|installer -> row
  const rows = new Map<string, BoardRow>();
  for (const t of tasks) {
    const crew = [t.a, t.b].filter((x): x is number => Boolean(x));
    const run = daysByTask.get(t.id);
    const slots: Array<{ date: string; installerId: number }> = [];
    if (run && run.length) {
      for (const d of run) {
        if (d.date < from || d.date > to) continue;
        const who = d.installerId ? [d.installerId] : crew;
        for (const i of who) slots.push({ date: d.date, installerId: i });
      }
    } else if (t.scheduledDate && t.scheduledDate >= from && t.scheduledDate <= to) {
      for (const i of crew) slots.push({ date: t.scheduledDate, installerId: i });
    }
    for (const s of slots) {
      const key = `${t.jobId}|${s.date}|${s.installerId}`;
      const row = rows.get(key);
      if (row) {
        if (!row.taskTitles.includes(t.title)) row.taskTitles.push(t.title);
        continue;
      }
      rows.set(key, {
        jobId: t.jobId,
        jobNumber: t.jobNumber,
        jobTitle: t.jobTitle,
        siteAddress: [t.address, t.suburb].filter(Boolean).join(", "),
        date: s.date,
        installerId: s.installerId,
        installerName: "",
        taskTitles: [t.title],
        record: null,
      });
    }
  }
  if (rows.size === 0) return [];

  const list = [...rows.values()];
  const installerIds = [...new Set(list.map((r) => r.installerId))];
  const jobIds = [...new Set(list.map((r) => r.jobId))];
  const [people, records] = await Promise.all([
    db
      .select({ id: schema.installers.id, name: schema.installers.name })
      .from(schema.installers)
      .where(inArray(schema.installers.id, installerIds)),
    db
      .select({
        id: schema.swmsRecords.id,
        jobId: schema.swmsRecords.jobId,
        installerId: schema.swmsRecords.installerId,
        workDate: schema.swmsRecords.workDate,
        signedAt: schema.swmsRecords.signedAt,
        signedName: schema.swmsRecords.signedName,
        kind: schema.swmsRecords.kind,
      })
      .from(schema.swmsRecords)
      .where(
        and(
          inArray(schema.swmsRecords.jobId, jobIds),
          gte(schema.swmsRecords.workDate, from),
          lte(schema.swmsRecords.workDate, to),
        ),
      ),
  ]);
  const names = new Map(people.map((p) => [p.id, p.name]));
  // Latest signing wins if someone signed twice in a day.
  const signed = new Map<string, (typeof records)[number]>();
  for (const r of records) {
    const k = `${r.jobId}|${r.workDate}|${r.installerId}`;
    const prev = signed.get(k);
    if (!prev || prev.signedAt < r.signedAt) signed.set(k, r);
  }
  for (const r of list) {
    r.installerName = names.get(r.installerId) ?? "Installer";
    const rec = signed.get(`${r.jobId}|${r.date}|${r.installerId}`);
    r.record = rec ? { id: rec.id, signedAt: rec.signedAt, signedName: rec.signedName, kind: rec.kind } : null;
  }
  return list.sort((a, b) => a.date.localeCompare(b.date) || String(a.jobNumber).localeCompare(String(b.jobNumber), undefined, { numeric: true }) || a.installerName.localeCompare(b.installerName));
}
