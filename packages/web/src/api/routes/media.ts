import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { signMany } from "../lib/s3";

/**
 * THE JOB FILE. Every photo, video and document lives in exactly one named
 * bucket — no endless diary feed. Nothing is ever deleted: the crew can't, and
 * the office archives instead, so the record survives an argument.
 */
export const BUCKETS = ["plan", "access", "area", "damage", "found", "completion", "defect", "client_reported"] as const;
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
};

const bucketEnum = z.enum(BUCKETS);

export const media = {
  /** Everything on a job, grouped by bucket, links signed for an hour. */
  list: staffOnly
    .input(z.object({ jobId: z.number(), includeArchived: z.boolean().default(false) }))
    .handler(async ({ input }) => {
      const rows = await db
        .select()
        .from(schema.jobMedia)
        .where(
          input.includeArchived
            ? eq(schema.jobMedia.jobId, input.jobId)
            : and(eq(schema.jobMedia.jobId, input.jobId), isNull(schema.jobMedia.archivedAt)),
        )
        .orderBy(asc(schema.jobMedia.capturedAt));

      const signed = await signMany(rows);
      return BUCKETS.map((bucket) => ({
        bucket,
        label: BUCKET_LABELS[bucket],
        items: signed.filter((r) => r.bucket === bucket),
      }));
    }),

  /** Called after the browser has PUT the file straight to storage. */
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
        })
        .returning();
      return row;
    }),

  setCaption: staffOnly
    .input(z.object({ id: z.number(), caption: z.string().nullable() }))
    .handler(async ({ input }) => {
      const [row] = await db
        .update(schema.jobMedia)
        .set({ caption: input.caption, updatedAt: new Date() })
        .where(eq(schema.jobMedia.id, input.id))
        .returning();
      return row;
    }),

  /** Put a stray photo in the right bucket or area. */
  move: staffOnly
    .input(z.object({ id: z.number(), bucket: bucketEnum, areaId: z.number().nullable().optional() }))
    .handler(async ({ input }) => {
      const [row] = await db
        .update(schema.jobMedia)
        .set({ bucket: input.bucket, areaId: input.areaId ?? null, updatedAt: new Date() })
        .where(eq(schema.jobMedia.id, input.id))
        .returning();
      return row;
    }),

  /** Office only, and it's an archive — the row and the file both stay. */
  archive: adminOnly.input(z.object({ id: z.number(), archived: z.boolean().default(true) })).handler(async ({ input }) => {
    const [row] = await db
      .update(schema.jobMedia)
      .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.jobMedia.id, input.id))
      .returning();
    return row;
  }),

  /** Before/after set to send the customer or drop on a landing page. */
  customerPack: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const rows = await db
      .select()
      .from(schema.jobMedia)
      .where(and(eq(schema.jobMedia.jobId, input.jobId), isNull(schema.jobMedia.archivedAt)))
      .orderBy(asc(schema.jobMedia.capturedAt));
    const signed = await signMany(rows);
    return {
      before: signed.filter((r) => r.bucket === "damage" || r.bucket === "area"),
      after: signed.filter((r) => r.bucket === "completion"),
    };
  }),
};
