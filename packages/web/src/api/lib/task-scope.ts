import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { jobText, taskRef } from "./refs";

/* ---------------------------------------------------------------------------
 * Who on the crew sees what, on a job with more than one crew (Damien, 15 Nov
 * 2026, job 188070: Paul on the carpet tiles, Fabrizio on the hybrid).
 *
 * Shared by every crew on the job: the address, the site contacts, the access
 * notes, Site access photos and the SWMS. Those are about the site, not the
 * work.
 *
 * Kept to one dispatch: the labour lines, the materials and their quantities
 * and pickups, the areas, and the photos and documents in every other part of
 * the job file, during the work and after it.
 *
 * A material, area or file is his when it carries one of his dispatches
 * (task_id). On a job where he holds every work dispatch, the untagged ones
 * are his too, so a one-crew job reads exactly as before. On a job with more
 * than one crew, an untagged one is office only until the office picks a
 * dispatch or ticks "Every crew on this job" (crew_shared). Nothing is ever
 * shown to everyone because nobody decided.
 *
 * Measure, site visit and inspection tasks are not work dispatches: they never
 * make a job count as two crews, and the measurer's photos are not anyone's
 * work. They follow the untagged rule.
 *
 * Office and admin are not filtered here. They see everything their existing
 * permissions allow (lib/file-access.ts).
 * ------------------------------------------------------------------------- */

/** Measure & quote, site visits and inspections: not a work dispatch. Same words as Needs attention (lib/widget.ts). */
export const VISIT_TASK = /\bmeasure|site visit|inspection/i;

/** Buckets that are about the site, not the work: every crew on the job gets them. */
export const SHARED_BUCKETS = ["access"] as const;

export type ScopeTask = {
  id: number;
  status: string;
  assignedInstallerId: number | null;
  secondInstallerId: number | null;
  skillName: string | null;
  title: string | null;
};

export type JobScope = {
  jobId: number;
  /** Live (not cancelled) tasks on the job, visits included. */
  live: ScopeTask[];
  /** Live work dispatches: not a measure, site visit or inspection. */
  work: ScopeTask[];
  /** More than one crew on the work dispatches. An unassigned dispatch is a crew nobody has picked yet. */
  multiCrew: boolean;
};

export type ViewerScope = JobScope & {
  installerId: number;
  /** His live tasks on the job, visits included. */
  mine: Set<number>;
  /** He holds every live work dispatch (always true when there is only one crew). */
  coversAll: boolean;
};

const isVisit = (t: Pick<ScopeTask, "skillName" | "title">) => VISIT_TASK.test(t.skillName ?? t.title ?? "");
const holds = (t: ScopeTask, installerId: number) => t.assignedInstallerId === installerId || t.secondInstallerId === installerId;
const crewKey = (t: ScopeTask) =>
  t.assignedInstallerId == null && t.secondInstallerId == null
    ? `open:${t.id}`
    : [t.assignedInstallerId, t.secondInstallerId]
        .filter((n): n is number => n != null)
        .sort((a, b) => a - b)
        .join("+");

/** Pure: the job's crews from its tasks. */
export function jobScopeOf(jobId: number, tasks: ScopeTask[]): JobScope {
  const live = tasks.filter((t) => t.status !== "cancelled");
  const work = live.filter((t) => !isVisit(t));
  return { jobId, live, work, multiCrew: new Set(work.map(crewKey)).size > 1 };
}

/** Pure: one installer's view of the job. */
export function viewerScopeOf(job: JobScope, installerId: number): ViewerScope {
  const mine = new Set(job.live.filter((t) => holds(t, installerId)).map((t) => t.id));
  const coversAll = job.work.every((t) => holds(t, installerId));
  return { ...job, installerId, mine, coversAll };
}

export async function loadJobScopes(jobIds: number[]): Promise<Map<number, JobScope>> {
  const ids = [...new Set(jobIds)];
  const out = new Map<number, JobScope>();
  if (!ids.length) return out;
  const rows = await db
    .select({
      jobId: schema.jobTasks.jobId,
      id: schema.jobTasks.id,
      status: schema.jobTasks.status,
      assignedInstallerId: schema.jobTasks.assignedInstallerId,
      secondInstallerId: schema.jobTasks.secondInstallerId,
      skillName: schema.skills.name,
      title: schema.jobTasks.title,
    })
    .from(schema.jobTasks)
    .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
    .where(inArray(schema.jobTasks.jobId, ids));
  for (const id of ids) out.set(id, jobScopeOf(id, rows.filter((r) => r.jobId === id)));
  return out;
}

export async function jobScope(jobId: number): Promise<JobScope> {
  return (await loadJobScopes([jobId])).get(jobId)!;
}

export async function viewerScope(jobId: number, installerId: number): Promise<ViewerScope> {
  return viewerScopeOf(await jobScope(jobId), installerId);
}

/**
 * The one rule for a tagged-or-not row. A tag to one of his tasks: his.
 * Ticked "Every crew on this job": his (the tag still says whose it was). A
 * tag to someone else's live work dispatch: not his. No tag, or a tag to a
 * visit or a cancelled task: his only when he holds every work dispatch.
 */
export function crewGets(v: ViewerScope, row: { taskId: number | null; crewShared?: boolean | null }): boolean {
  if (row.taskId != null && v.mine.has(row.taskId)) return true;
  if (row.crewShared) return true;
  if (row.taskId != null && v.work.some((t) => t.id === row.taskId)) return false;
  return v.coversAll;
}

/** Job file rows: Site access is the site's, so every crew on the job gets it. His own uploads are always his. */
export function crewGetsFile(
  v: ViewerScope,
  row: { taskId: number | null; crewShared?: boolean | null; bucket: string; uploadedByInstallerId: number | null },
): boolean {
  if (row.uploadedByInstallerId != null && row.uploadedByInstallerId === v.installerId) return true;
  if ((SHARED_BUCKETS as readonly string[]).includes(row.bucket)) return true;
  return crewGets(v, row);
}

/**
 * Office side: does this row still need a dispatch? Only on a job with more
 * than one crew, and only when no crew can see it for want of a decision.
 */
export function needsDispatch(job: JobScope, row: { taskId: number | null; crewShared?: boolean | null; bucket?: string }): boolean {
  if (!job.multiCrew) return false;
  if (row.bucket && (SHARED_BUCKETS as readonly string[]).includes(row.bucket)) return false;
  if (row.crewShared) return false;
  return row.taskId == null || !job.work.some((t) => t.id === row.taskId);
}

/** A dispatch the office may tag a row with: a live task on this same job. */
export async function assertTaskOnJob(taskId: number, jobId: number) {
  const [t] = await db
    .select({ id: schema.jobTasks.id })
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.id, taskId), eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")));
  return Boolean(t);
}

/** "188070-B", for the record. */
export async function dispatchRef(taskId: number): Promise<string> {
  const [t] = await db
    .select({ seq: schema.jobTasks.seq, number: schema.jobs.number, displayNumber: schema.jobs.displayNumber })
    .from(schema.jobTasks)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .where(eq(schema.jobTasks.id, taskId));
  return t ? taskRef(jobText(t), t.seq) : `task ${taskId}`;
}

/** The words for where a row now sits, for the activity feed. */
export async function scopeWords(row: { taskId: number | null; crewShared: boolean | null }): Promise<string> {
  if (row.crewShared) return "every crew on this job";
  if (row.taskId != null) return `dispatch ${await dispatchRef(row.taskId)}`;
  return "no dispatch (office only while more than one crew is on the job)";
}

/* ---------------------------------------------------------------------------
 * Which crew sees what (Damien, 16 Nov 2026): "make it easy to show whom sees
 * what, so a dummy can work it out". The office card on the job page reads
 * this. It runs the exact same rules as the phone (crewGets, crewGetsFile),
 * once for each person on the work, and once for each dispatch nobody is on
 * yet, as if that person were already on it.
 * ------------------------------------------------------------------------- */

export type CrewViewMaterial = { id: number; taskId: number | null; crewShared: boolean | null };
/** crewVisible: the file itself is cleared for crew (lib/file-access.ts crewMaySee). An uncleared one only reaches the installer who took it. */
export type CrewViewFile = { id: number; taskId: number | null; crewShared: boolean | null; bucket: string; uploadedByInstallerId: number | null; crewVisible: boolean };

export type CrewViewCrew = {
  /** The person, or null for a dispatch nobody is on yet. */
  installerId: number | null;
  /** His work dispatches on this job. */
  taskIds: number[];
  materials: { id: number; shared: boolean }[];
  files: { id: number; bucket: string; shared: boolean }[];
};

/** Pure. Files: not archived, not restricted, not an office only bucket. */
export function crewViewOf(job: JobScope, materials: CrewViewMaterial[], files: CrewViewFile[]) {
  const viewers: { installerId: number | null; v: ViewerScope }[] = [];
  const people = [...new Set(job.work.flatMap((t) => [t.assignedInstallerId, t.secondInstallerId]).filter((n): n is number => n != null))];
  for (const p of people) viewers.push({ installerId: p, v: viewerScopeOf(job, p) });
  for (const t of job.work) {
    if (t.assignedInstallerId != null || t.secondInstallerId != null) continue;
    // Nobody on it yet: what its installer will see once the office puts someone on.
    viewers.push({ installerId: null, v: { ...job, installerId: -1, mine: new Set([t.id]), coversAll: job.work.every((w) => w.id === t.id) } });
  }
  const crews: CrewViewCrew[] = viewers.map(({ installerId, v }) => ({
    installerId,
    taskIds: job.work.filter((t) => v.mine.has(t.id)).map((t) => t.id),
    materials: materials.filter((m) => crewGets(v, m)).map((m) => ({ id: m.id, shared: Boolean(m.crewShared) || !job.multiCrew })),
    files: files
      .filter((f) => (f.crewVisible || f.uploadedByInstallerId === v.installerId) && crewGetsFile(v, f))
      .map((f) => ({ id: f.id, bucket: f.bucket, shared: Boolean(f.crewShared) || (SHARED_BUCKETS as readonly string[]).includes(f.bucket) })),
  }));
  const seen = (pick: (c: CrewViewCrew) => { id: number }[]) => new Set(crews.flatMap((c) => pick(c).map((x) => x.id)));
  const seenM = seen((c) => c.materials);
  const seenF = seen((c) => c.files);
  return {
    multiCrew: job.multiCrew,
    crews,
    nobody: {
      materials: materials.filter((m) => !seenM.has(m.id)).map((m) => m.id),
      // Only files cleared for crew: an office only file is waiting on "Show to crew", not on a dispatch.
      files: files.filter((f) => f.crewVisible && !seenF.has(f.id)).map((f) => ({ id: f.id, bucket: f.bucket })),
    },
  };
}
