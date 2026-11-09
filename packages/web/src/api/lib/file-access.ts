import { and, eq, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";

/* ---------------------------------------------------------------------------
 * Who may retrieve a job file (Damien, 9 Nov 2026: document privacy).
 *
 * A file has a category (its bucket: Plans, Site access ...) and, separately,
 * a visibility. Category never grants access. Deny by default:
 *
 *   Crew      only rows marked visibility "crew", never sensitivity
 *             "restricted", never an office-only bucket, never archived, and
 *             only on a job they hold a task on. Their own uploads always.
 *   Office    everything except cost documents (supplier costs, bank
 *             details, unidentified price content), which need "can see
 *             costs", the same rule as costs everywhere else.
 *   Admin     everything.
 *
 * Every server path that lists or signs a job file goes through here, so the
 * phone and the browser never receive a link, caption or filename they
 * should not have. Hiding on screen is not the control.
 * ------------------------------------------------------------------------- */

/** Buckets the crew never get, whatever a row says. */
export const OFFICE_ONLY_BUCKETS = ["signed"] as const;

/** The slots the crew may add to from the phone. Never Plans, Client photos or Signed documents. */
export const CREW_BUCKETS = ["access", "area", "damage", "found", "completion", "defect"] as const;

/** Restricted for crew AND for office without cost access. */
export const COST_REASONS = ["supplier_cost", "bank", "price_content"] as const;

export const RESTRICT_LABELS: Record<string, string> = {
  customer_quote: "Customer quote",
  customer_invoice: "Customer invoice",
  signed: "Signed document",
  supplier_cost: "Supplier costs",
  bank: "Bank details",
  payment: "Payment record",
  price_content: "Prices in it",
};

export const VISIBILITY_LABELS: Record<string, string> = { crew: "Crew can see", office: "Office only" };
export const REVIEW_LABELS: Record<string, string> = { needs_review: "Needs review", approved: "Shown to crew", kept_office: "Kept office only" };

type Row = {
  bucket: string;
  visibility: string;
  sensitivity: string;
  restrictReason: string | null;
  archivedAt: Date | null;
  uploadedByInstallerId: number | null;
  classifiedAt?: Date | null;
};

/**
 * A crew upload from before the privacy columns were filled (the gap between
 * the SQL and Publish) is still shared with the crew on its job, as it was.
 * Every row the backfill or the new code touches has classifiedAt set.
 */
const legacyCrewUpload = (row: Row) => row.uploadedByInstallerId !== null && !row.classifiedAt;

/** The one crew rule, for a row already loaded. */
export function crewMaySee(row: Row, installerId: number) {
  if (row.archivedAt) return false;
  if ((OFFICE_ONLY_BUCKETS as readonly string[]).includes(row.bucket)) return false;
  if (row.sensitivity === "restricted") return false;
  if (row.uploadedByInstallerId === installerId) return true;
  return row.visibility === "crew" || legacyCrewUpload(row);
}

/** People outside the office who are not crew (the repairer's photo page): crew-visible, unrestricted rows only. */
export function outsideWhere(): SQL {
  const m = schema.jobMedia;
  return and(isNull(m.archivedAt), notInArray(m.bucket, [...OFFICE_ONLY_BUCKETS]), ne(m.sensitivity, "restricted"), eq(m.visibility, "crew"))!;
}

/** The same rule as SQL, for listing. Pair it with the job filter. */
export function crewWhere(installerId: number): SQL {
  const m = schema.jobMedia;
  return and(
    isNull(m.archivedAt),
    notInArray(m.bucket, [...OFFICE_ONLY_BUCKETS]),
    ne(m.sensitivity, "restricted"),
    or(eq(m.visibility, "crew"), eq(m.uploadedByInstallerId, installerId), and(isNotNull(m.uploadedByInstallerId), isNull(m.classifiedAt))),
  )!;
}

/** Office and admin: may this person open the file itself? */
export function staffMayOpen(row: Pick<Row, "sensitivity" | "restrictReason">, actor: Pick<Actor, "role" | "canSeeCosts">) {
  if (actor.role === "field") return false;
  if (actor.role === "admin") return true;
  if (row.sensitivity !== "restricted") return true;
  if ((COST_REASONS as readonly string[]).includes(row.restrictReason ?? "price_content")) return actor.canSeeCosts;
  return true;
}

/** Does this installer hold a live task on the job? A login on its own is never enough. */
export async function installerOnJob(installerId: number, jobId: number) {
  const [t] = await db
    .select({ id: schema.jobTasks.id })
    .from(schema.jobTasks)
    .where(
      and(
        eq(schema.jobTasks.jobId, jobId),
        ne(schema.jobTasks.status, "cancelled"),
        sql`(${schema.jobTasks.assignedInstallerId} = ${installerId} or ${schema.jobTasks.secondInstallerId} = ${installerId})`,
      ),
    )
    .limit(1);
  return Boolean(t);
}

/** May this installer have this one file? Assignment is checked on every request, so taking him off the job ends it. */
export async function crewMayOpen(row: Row & { jobId: number }, installerId: number) {
  if (!crewMaySee(row, installerId)) return false;
  if (await installerOnJob(installerId, row.jobId)) return true;
  // A callback's crew also get the original job's file, read only.
  const kids = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(eq(schema.jobs.parentJobId, row.jobId));
  for (const k of kids) if (await installerOnJob(installerId, k.id)) return true;
  return false;
}

/** Who did it, for the record. */
export const byLine = (actor: Pick<Actor, "name" | "role">) => `${actor.name || "Office"} (${actor.role})`;

/** One line in the activity feed. Never the file's content, a code or a price. */
export async function logFileAccess(args: { jobId: number; mediaId: number; action: string; detail: string; actor: { name: string; role: string } | null }) {
  await db.insert(schema.activityLog).values({
    jobId: args.jobId,
    entityType: "job_media",
    entityId: args.mediaId,
    action: args.action,
    detail: args.detail.slice(0, 500),
    actorName: (args.actor?.name || "Terra Ops").slice(0, 120),
    actorRole: args.actor?.role ?? "system",
  });
}
