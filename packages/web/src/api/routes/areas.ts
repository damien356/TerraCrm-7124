import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";

/**
 * Areas are the rooms or zones the work covers — Kitchen 14 m², Hallway 8 m².
 * Photos attach to the area, so the crew open "Kitchen" and see exactly what
 * they're covering instead of scrolling a pile of loose job photos.
 */
export const areas = {
  list: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    return db
      .select()
      .from(schema.jobAreas)
      .where(eq(schema.jobAreas.jobId, input.jobId))
      .orderBy(asc(schema.jobAreas.sortOrder), asc(schema.jobAreas.id));
  }),

  create: staffOnly
    .input(
      z.object({
        jobId: z.number(),
        name: z.string().min(1, "Give the area a name."),
        areaM2: z.number().nullable().optional(),
        taskId: z.number().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const existing = await db.select().from(schema.jobAreas).where(eq(schema.jobAreas.jobId, input.jobId));
      const [row] = await db
        .insert(schema.jobAreas)
        .values({ ...input, sortOrder: existing.length })
        .returning();
      return row;
    }),

  update: staffOnly
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        areaM2: z.number().nullable().optional(),
        taskId: z.number().nullable().optional(),
        notes: z.string().nullable().optional(),
        sortOrder: z.number().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.jobAreas)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.jobAreas.id, id))
        .returning();
      return row;
    }),

  /** Photos already taken keep their history — they just lose the area tag. */
  remove: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.jobAreas).where(eq(schema.jobAreas.id, input.id));
    return { ok: true };
  }),
};
