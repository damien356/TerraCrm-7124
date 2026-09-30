import { z } from "zod";
import { and, asc, desc, eq, gte, lte, or } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { parseUnavailability } from "../lib/parse-unavailability";
import { blockedInstallerIds, checkDays, nonWorkingWeekdays } from "../lib/availability";

/**
 * Blackout dates. Damien types it the way he'd say it — "cant work dec 1-17
 * japan trip" or "never works weekends" — and we turn it into real blocked
 * ranges or a standing weekday rule. The system then refuses to book that
 * installer on those days; it is not a UI-only warning.
 */
export const availability = {
  /** Everything blocked for one installer. */
  list: adminOnly.input(z.object({ installerId: z.number() })).handler(async ({ input }) => {
    return db
      .select()
      .from(schema.installerUnavailability)
      .where(eq(schema.installerUnavailability.installerId, input.installerId))
      .orderBy(desc(schema.installerUnavailability.fromDate), asc(schema.installerUnavailability.id));
  }),

  /** Everything blocked across a date window — feeds the schedule board. */
  inRange: adminOnly
    .input(z.object({ from: z.string(), to: z.string() }))
    .handler(async ({ input }) => {
      return db
        .select()
        .from(schema.installerUnavailability)
        .where(
          or(
            eq(schema.installerUnavailability.kind, "recurring"),
            and(
              lte(schema.installerUnavailability.fromDate, input.to),
              gte(schema.installerUnavailability.toDate, input.from),
            ),
          ),
        );
    }),

  /** Preview what a typed line means before saving it. Nothing is written. */
  preview: adminOnly.input(z.object({ text: z.string() })).handler(({ input }) => {
    const parsed = parseUnavailability(input.text);
    return { entries: parsed, understood: parsed.length > 0 };
  }),

  /** Save from plain English. Returns what it actually recorded. */
  addFromText: adminOnly
    .input(z.object({ installerId: z.number(), text: z.string().min(2) }))
    .handler(async ({ input }) => {
      const parsed = parseUnavailability(input.text);
      if (parsed.length === 0) {
        throw new ORPCError("BAD_REQUEST", {
          message:
            "Couldn't read dates out of that. Try something like \"off Dec 1-17, Japan trip\" or \"never works weekends\".",
        });
      }
      const rows = await db
        .insert(schema.installerUnavailability)
        .values(
          parsed.map((p) => ({
            installerId: input.installerId,
            kind: p.kind,
            fromDate: p.fromDate ?? null,
            toDate: p.toDate ?? null,
            weekdayMask: JSON.stringify(p.weekdays ?? []),
            reason: p.reason,
            rawText: input.text.trim(),
          })),
        )
        .returning();
      return rows;
    }),

  /** Manual entry when he'd rather pick the dates himself. */
  add: adminOnly
    .input(
      z.object({
        installerId: z.number(),
        kind: z.enum(["range", "recurring"]).default("range"),
        fromDate: z.string().nullable().optional(),
        toDate: z.string().nullable().optional(),
        weekdays: z.array(z.number().int().min(0).max(6)).default([]),
        reason: z.string().default(""),
      }),
    )
    .handler(async ({ input }) => {
      if (input.kind === "range" && !(input.fromDate && input.toDate)) {
        throw new ORPCError("BAD_REQUEST", { message: "A blocked range needs a start and an end date." });
      }
      const [row] = await db
        .insert(schema.installerUnavailability)
        .values({
          installerId: input.installerId,
          kind: input.kind,
          fromDate: input.fromDate ?? null,
          toDate: input.toDate ?? null,
          weekdayMask: JSON.stringify(input.weekdays),
          reason: input.reason,
          rawText: "",
        })
        .returning();
      return row;
    }),

  remove: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.installerUnavailability).where(eq(schema.installerUnavailability.id, input.id));
    return { ok: true };
  }),

  /** Who is blocked on a given day — the check the dispatch pickers run. */
  blockedOn: adminOnly.input(z.object({ date: z.string() })).handler(async ({ input }) => {
    const ids = await blockedInstallerIds(input.date);
    return [...ids];
  }),

  /**
   * One installer across the exact days a booking would use: day off, booked
   * out, or already on something. Read live by the Book Installer panel so the
   * office sees the clash before they press the button, not after.
   */
  checkDays: adminOnly
    .input(
      z.object({
        installerId: z.number(),
        dates: z.array(z.string()).max(60),
        exceptTaskId: z.number().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      return checkDays({
        installerId: input.installerId,
        dates: input.dates,
        exceptTaskId: input.exceptTaskId ?? null,
      });
    }),

  /** The weekdays an installer never works, so a run can step over them. */
  nonWorkingWeekdays: adminOnly.input(z.object({ installerId: z.number() })).handler(async ({ input }) => {
    return nonWorkingWeekdays(input.installerId);
  }),
};
