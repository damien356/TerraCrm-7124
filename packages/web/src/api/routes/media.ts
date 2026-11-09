import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly, type Actor } from "../middleware/auth";
import { signGet, signMany } from "../lib/s3";
import { OFFICE_ONLY_BUCKETS, RESTRICT_LABELS, byLine, logFileAccess, outsideWhere, staffMayOpen } from "../lib/file-access";
import { askOfficeToCheck, checkLater } from "../lib/doc-classify";

/**
 * THE JOB FILE. Every photo, video and document lives in exactly one named
 * bucket — no endless diary feed. Nothing is ever deleted: the crew can't, and
 * the office archives instead, so the record survives an argument.
 */
export const BUCKETS = ["plan", "access", "area", "damage", "found", "completion", "defect", "client_reported", "signed"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BUCKET_LABELS: Record<Bucket, string> = {
  plan: "Plans",
  access: "Site access",
  area: "Areas we're doing",
  damage: "Existing damage",
  found: "What we found",
  completion: "Completion",
  defect: "Defects & callbacks",
  /** What the client sent in about a callback: emailed or texted photos, filed by the office. */
  client_reported: "Client photos",
  /** Signed paperwork such as an accepted variation. Office only: the crew never gets this bucket. */
  signed: "Signed documents",
};

/** Buckets the crew never sees on the phone, on a job or on a callback's original job. One list, in file-access. */
export { OFFICE_ONLY_BUCKETS } from "../lib/file-access";

const bucketEnum = z.enum(BUCKETS);

type MediaRow = typeof schema.jobMedia.$inferSelect;

/**
 * One file as the office sees it. Someone who may not open it (a cost
 * document, for office without "can see costs") gets the tile and the label,
 * never the link, the name, the caption or the note.
 */
async function forStaff(r: MediaRow, actor: Actor) {
  const open = staffMayOpen(r, actor);
  const restrictLabel = r.sensitivity === "restricted" ? (RESTRICT_LABELS[r.restrictReason ?? ""] ?? "Restricted") : null;
  const base = {
    id: r.id,
    jobId: r.jobId,
    taskId: r.taskId,
    areaId: r.areaId,
    bucket: r.bucket,
    kind: r.kind,
    sizeBytes: r.sizeBytes,
    durationSeconds: r.durationSeconds,
    capturedAt: r.capturedAt,
    archivedAt: r.archivedAt,
    uploaderName: r.uploaderName,
    uploadedByInstallerId: r.uploadedByInstallerId,
    visibility: r.visibility,
    sensitivity: r.sensitivity,
    reviewStatus: r.reviewStatus,
    restrictLabel,
    reviewedByName: r.reviewedByName,
    reviewedAt: r.reviewedAt,
    locked: !open,
  };
  if (!open) return { ...base, url: "", filename: null as string | null, caption: null as string | null, mime: null as string | null, classifyNote: null as string | null };
  return { ...base, url: await signGet(r.storageKey), filename: r.filename, caption: r.caption, mime: r.mime, classifyNote: r.classifyNote };
}

async function rowOrThrow(id: number) {
  const [row] = await db.select().from(schema.jobMedia).where(eq(schema.jobMedia.id, id)).limit(1);
  if (!row) throw new ORPCError("NOT_FOUND", { message: "That file is not there any more." });
  return row;
}

function mustOpen(row: MediaRow, actor: Actor) {
  if (!staffMayOpen(row, actor)) throw new ORPCError("FORBIDDEN", { message: "This file is restricted to people who can see costs." });
}

export const media = {
  /** Everything on a job, grouped by bucket, links signed for an hour. */
  list: staffOnly
    .input(z.object({ jobId: z.number(), includeArchived: z.boolean().default(false) }))
    .handler(async ({ input, context }) => {
      const rows = await db
        .select()
        .from(schema.jobMedia)
        .where(
          input.includeArchived
            ? eq(schema.jobMedia.jobId, input.jobId)
            : and(eq(schema.jobMedia.jobId, input.jobId), isNull(schema.jobMedia.archivedAt)),
        )
        .orderBy(asc(schema.jobMedia.capturedAt));

      const shown = await Promise.all(rows.map((r) => forStaff(r, context.actor)));
      return BUCKETS.map((bucket) => ({
        bucket,
        label: BUCKET_LABELS[bucket],
        items: shown.filter((r) => r.bucket === bucket),
      }));
    }),

  /**
   * Called after the browser has PUT the file straight to storage. The row
   * starts office only and needs-review, and the content check decides from
   * there. The crew never see a file while it is being checked.
   */
  attach: staffOnly
    .input(
      z.object({
        jobId: z.number(),
        taskId: z.number().nullable().optional(),
        areaId: z.number().nullable().optional(),
        bucket: bucketEnum,
        kind: z.enum(["photo", "video", "doc"]).default("photo"),
        storageKey: z.string().min(1),
        filename: z.string().nullable().optional(),
        mime: z.string().nullable().optional(),
        sizeBytes: z.number().nullable().optional(),
        durationSeconds: z.number().nullable().optional(),
        caption: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      if (!input.storageKey.startsWith(`jobs/${input.jobId}/`) || input.storageKey.includes("..")) {
        throw new ORPCError("BAD_REQUEST", { message: "That upload did not go to this job. Upload it again." });
      }
      const [profile] = await db
        .select({ id: schema.profiles.id })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, context.actor.userId));

      const [row] = await db
        .insert(schema.jobMedia)
        .values({
          ...input,
          url: input.storageKey,
          uploadedByProfileId: profile?.id ?? null,
          uploaderName: context.actor.name || "Office",
          visibility: "office",
          sensitivity: "unknown",
          reviewStatus: "needs_review",
          classifiedAt: null,
        })
        .returning();
      checkLater(row!.id, "office", { name: context.actor.name || "Office", role: context.actor.role });
      return row;
    }),

  setCaption: staffOnly
    .input(z.object({ id: z.number(), caption: z.string().nullable() }))
    .handler(async ({ input, context }) => {
      mustOpen(await rowOrThrow(input.id), context.actor);
      const [row] = await db
        .update(schema.jobMedia)
        .set({ caption: input.caption, updatedAt: new Date() })
        .where(eq(schema.jobMedia.id, input.id))
        .returning();
      return row;
    }),

  /** Put a stray photo in the right bucket or area. Moving never changes who can see it. */
  move: staffOnly
    .input(z.object({ id: z.number(), bucket: bucketEnum, areaId: z.number().nullable().optional() }))
    .handler(async ({ input, context }) => {
      const was = await rowOrThrow(input.id);
      mustOpen(was, context.actor);
      // Into Signed documents means office only, and it stays that way.
      const toSigned = (OFFICE_ONLY_BUCKETS as readonly string[]).includes(input.bucket);
      const [row] = await db
        .update(schema.jobMedia)
        .set({
          bucket: input.bucket,
          areaId: input.areaId ?? null,
          updatedAt: new Date(),
          ...(toSigned ? { visibility: "office", reviewStatus: "kept_office" } : {}),
        })
        .where(eq(schema.jobMedia.id, input.id))
        .returning();
      if (was.bucket !== input.bucket) {
        await logFileAccess({
          jobId: was.jobId,
          mediaId: was.id,
          action: "file_moved",
          detail: `File ${was.id} moved from ${BUCKET_LABELS[was.bucket as Bucket] ?? was.bucket} to ${BUCKET_LABELS[input.bucket]} by ${byLine(context.actor)}`,
          actor: { name: context.actor.name, role: context.actor.role },
        });
      }
      return row;
    }),

  /** Office only, and it's an archive — the row and the file both stay. Logged with who did it. */
  archive: adminOnly.input(z.object({ id: z.number(), archived: z.boolean().default(true) })).handler(async ({ input, context }) => {
    const was = await rowOrThrow(input.id);
    const [row] = await db
      .update(schema.jobMedia)
      .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.jobMedia.id, input.id))
      .returning();
    await logFileAccess({
      jobId: was.jobId,
      mediaId: was.id,
      action: input.archived ? "file_archived" : "file_restored",
      detail: `File ${was.id} ${input.archived ? "archived" : "restored"} by ${byLine(context.actor)}${was.sensitivity === "restricted" ? ". It stays office only." : ""}`,
      actor: { name: context.actor.name, role: context.actor.role },
    });
    return row;
  }),

  /**
   * "Show to crew". A person looked at it and says the crew may have it.
   * Restricted files can never be shown: a quote, invoice, signed paper,
   * cost or payment record stays office only whatever anyone ticks.
   */
  approveForCrew: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const was = await rowOrThrow(input.id);
    mustOpen(was, context.actor);
    if (was.sensitivity === "restricted") {
      throw new ORPCError("BAD_REQUEST", { message: `This is a ${(RESTRICT_LABELS[was.restrictReason ?? ""] ?? "restricted file").toLowerCase()}. It stays office only.` });
    }
    if ((OFFICE_ONLY_BUCKETS as readonly string[]).includes(was.bucket)) {
      throw new ORPCError("BAD_REQUEST", { message: "Signed documents stay office only. Move it to another slot first if it is not signed paperwork." });
    }
    const by = context.actor.name || "Office";
    const [row] = await db
      .update(schema.jobMedia)
      .set({ visibility: "crew", sensitivity: "normal", reviewStatus: "approved", reviewedByName: by, reviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.jobMedia.id, input.id))
      .returning();
    await logFileAccess({ jobId: was.jobId, mediaId: was.id, action: "file_shown_to_crew", detail: `File ${was.id} shown to crew by ${byLine(context.actor)}`, actor: { name: by, role: context.actor.role } });
    await askOfficeToCheck(was.jobId);
    return row;
  }),

  /** "Keep office only". Also how a file already shown to the crew is taken back off them. */
  keepOffice: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const was = await rowOrThrow(input.id);
    mustOpen(was, context.actor);
    const by = context.actor.name || "Office";
    const [row] = await db
      .update(schema.jobMedia)
      .set({ visibility: "office", reviewStatus: "kept_office", reviewedByName: by, reviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.jobMedia.id, input.id))
      .returning();
    await logFileAccess({
      jobId: was.jobId,
      mediaId: was.id,
      action: was.visibility === "crew" ? "file_crew_access_removed" : "file_kept_office",
      detail: `File ${was.id} ${was.visibility === "crew" ? "taken off the crew" : "kept office only"} by ${byLine(context.actor)}`,
      actor: { name: by, role: context.actor.role },
    });
    await askOfficeToCheck(was.jobId);
    return row;
  }),

  /**
   * Admin only: mark a file restricted, or lift a restriction that was wrong.
   * Lifting never shows it to the crew; it goes back to Needs review, and the
   * reason is kept in the activity feed.
   */
  reclassify: adminOnly
    .input(
      z.object({
        id: z.number(),
        restricted: z.boolean(),
        restrictReason: z.enum(["customer_quote", "customer_invoice", "signed", "supplier_cost", "bank", "payment", "price_content"]).optional(),
        reason: z.string().trim().min(5, "Say why, in a few words.").max(300),
      }),
    )
    .handler(async ({ input, context }) => {
      const was = await rowOrThrow(input.id);
      const by = context.actor.name || "Admin";
      const set = input.restricted
        ? { sensitivity: "restricted", restrictReason: input.restrictReason ?? "price_content", visibility: "office", reviewStatus: "kept_office" }
        : { sensitivity: "normal", restrictReason: null, visibility: "office", reviewStatus: "needs_review" };
      const [row] = await db
        .update(schema.jobMedia)
        .set({ ...set, reviewedByName: by, reviewedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.jobMedia.id, input.id))
        .returning();
      await logFileAccess({
        jobId: was.jobId,
        mediaId: was.id,
        action: input.restricted ? "file_restricted" : "file_restriction_lifted",
        detail: `File ${was.id} ${input.restricted ? `restricted (${RESTRICT_LABELS[set.restrictReason ?? ""] ?? "restricted"})` : "no longer restricted, back to Needs review"} by ${byLine(context.actor)}. Reason: ${input.reason}`,
        actor: { name: by, role: context.actor.role },
      });
      await askOfficeToCheck(was.jobId);
      return row;
    }),

  /** Before/after set to send the customer or drop on a landing page. Plain site photos only, never a restricted or unreviewed file. */
  customerPack: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const rows = await db
      .select()
      .from(schema.jobMedia)
      .where(and(eq(schema.jobMedia.jobId, input.jobId), outsideWhere()))
      .orderBy(asc(schema.jobMedia.capturedAt));
    const signed = await signMany(rows);
    return {
      before: signed.filter((r) => r.bucket === "damage" || r.bucket === "area"),
      after: signed.filter((r) => r.bucket === "completion"),
    };
  }),
};
