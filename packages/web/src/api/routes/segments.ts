import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import {
  PRODUCT_FAMILIES,
  describeRules,
  journeyEligibleFor,
  parseRules,
  segmentCounts,
  segmentOptions,
  segmentSample,
  type Audience,
} from "../lib/segments";
import { signalsFor, tradeReasons, tradeReviewQueue } from "../lib/trade";

/**
 * Segments — the saved questions about the contact book that decide who a
 * message may go to.
 *
 * Two things this route does deliberately, and neither is negotiable:
 *
 * 1. Every count comes back as a pair. `matching` is who fits the rules,
 *    `reachable` is who fits AND may lawfully be emailed. A segment of 300
 *    that can only be mailed to 40 is a consent problem, and one number hides
 *    it. The UI shows both, always.
 *
 * 2. A builder segment is forced non-journey-eligible on write. The office
 *    cannot tick that box, no matter what they send in the input.
 */

/** The rule blob, validated. Unknown keys are dropped by `parseRules` later. */
const rulesInput = z
  .object({
    suburbs: z.array(z.string().trim().min(1)).max(60).optional(),
    products: z
      .array(z.enum(PRODUCT_FAMILIES.map((f) => f.key) as [string, ...string[]]))
      .max(PRODUCT_FAMILIES.length)
      .optional(),
    completedWithinDays: z.number().int().positive().max(20_000).nullable().optional(),
    completedBeforeDays: z.number().int().positive().max(20_000).nullable().optional(),
    sources: z.array(z.string().trim()).max(40).optional(),
    minJobValue: z.number().positive().max(10_000_000).nullable().optional(),
    requireEmail: z.boolean().optional(),
  })
  .default({});

const audienceInput = z.enum(["homeowner", "builder"]);

const upsertInput = z.object({
  name: z.string().trim().min(1, "Give the segment a name").max(120),
  description: z.string().trim().max(500).default(""),
  audience: audienceInput.default("homeowner"),
  rules: rulesInput,
});

/**
 * A window that asks for "within 30 days" and "before 90 days" at once matches
 * nobody. Better to say so than hand the office a segment of nought and let
 * them wonder whether the data is wrong.
 */
function ruleWarnings(rules: ReturnType<typeof parseRules>): string[] {
  const out: string[] = [];
  if (
    rules.completedWithinDays &&
    rules.completedBeforeDays &&
    rules.completedBeforeDays >= rules.completedWithinDays
  ) {
    out.push(
      `Completed within ${rules.completedWithinDays} days and longer ago than ${rules.completedBeforeDays} days cannot both be true. This segment will always be empty.`,
    );
  }
  if (rules.requireEmail === false) {
    out.push("Email is not required, so this list is for post or phone. An email send will skip everyone without an address.");
  }
  return out;
}

export const segments = {
  /**
   * Every segment with its live pair of counts. Slower than a plain list on
   * purpose: a segment list showing stale numbers is worse than no numbers,
   * because the office plans a send off them.
   */
  list: adminOnly.handler(async () => {
    const rows = await db.select().from(schema.segments).orderBy(desc(schema.segments.updatedAt));

    /* How many sends have ever gone out against each one, so a segment that is
     * actually in use is obvious before someone edits its rules. */
    const usage = await db
      .select({ segmentId: schema.sends.segmentId, n: sql<number>`count(*)` })
      .from(schema.sends)
      .groupBy(schema.sends.segmentId);
    const sentBy = new Map(usage.map((u) => [u.segmentId, Number(u.n)]));

    return Promise.all(
      rows.map(async (s) => {
        const rules = parseRules(s.rules);
        const audience = s.audience as Audience;
        return {
          ...s,
          rules,
          summary: describeRules(rules, audience),
          counts: await segmentCounts(rules, audience),
          sendCount: sentBy.get(s.id) ?? 0,
        };
      }),
    );
  }),

  /** One segment, its counts, and a sample of who is in it. */
  get: adminOnly.input(z.object({ id: z.number().int() })).handler(async ({ input }) => {
    const [row] = await db.select().from(schema.segments).where(eq(schema.segments.id, input.id));
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Segment not found" });

    const rules = parseRules(row.rules);
    const audience = row.audience as Audience;

    /* Segments group blasts, not journeys — a journey enrols off its trigger.
     * So "in use" means mail has gone out against it, which is what makes an
     * edit or a delete consequential. */
    const [sent] = await db
      .select({
        n: sql<number>`count(*)`,
        last: sql<string | null>`max(${schema.sends.createdAt})`,
      })
      .from(schema.sends)
      .where(eq(schema.sends.segmentId, input.id));

    const [counts, sample] = await Promise.all([
      segmentCounts(rules, audience),
      segmentSample(rules, audience, 25),
    ]);

    return {
      segment: { ...row, rules },
      summary: describeRules(rules, audience),
      counts,
      sample,
      warnings: ruleWarnings(rules),
      sendCount: Number(sent?.n ?? 0),
      lastSentAt: sent?.last ?? null,
    };
  }),

  /**
   * Counts and a sample for rules that have not been saved yet, so the editor
   * can show the office what a change does before they commit to it.
   */
  preview: adminOnly
    .input(z.object({ audience: audienceInput.default("homeowner"), rules: rulesInput }))
    .handler(async ({ input }) => {
      const rules = parseRules(JSON.stringify(input.rules));
      const [counts, sample] = await Promise.all([
        segmentCounts(rules, input.audience),
        segmentSample(rules, input.audience, 25),
      ]);
      return {
        counts,
        sample,
        summary: describeRules(rules, input.audience),
        warnings: ruleWarnings(rules),
        journeyEligible: journeyEligibleFor(input.audience),
      };
    }),

  /** Real suburbs, sources and product families with real counts behind them. */
  options: adminOnly.handler(async () => segmentOptions()),

  create: adminOnly.input(upsertInput).handler(async ({ input }) => {
    const [row] = await db
      .insert(schema.segments)
      .values({
        name: input.name,
        description: input.description,
        audience: input.audience,
        rules: JSON.stringify(input.rules),
        /* Forced, never taken from the input. */
        journeyEligible: journeyEligibleFor(input.audience),
      })
      .returning();
    return row!;
  }),

  update: adminOnly
    .input(upsertInput.partial().extend({ id: z.number().int() }))
    .handler(async ({ input }) => {
      const [existing] = await db
        .select()
        .from(schema.segments)
        .where(eq(schema.segments.id, input.id));
      if (!existing) throw new ORPCError("NOT_FOUND", { message: "Segment not found" });

      const audience = (input.audience ?? existing.audience) as Audience;

      const [row] = await db
        .update(schema.segments)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.audience !== undefined ? { audience: input.audience } : {}),
          ...(input.rules !== undefined ? { rules: JSON.stringify(input.rules) } : {}),
          /* Recomputed on every write: flipping a segment to builder must drop
           * its journey eligibility in the same statement. */
          journeyEligible: journeyEligibleFor(audience),
          updatedAt: new Date(),
        })
        .where(eq(schema.segments.id, input.id))
        .returning();
      return row!;
    }),

  /**
   * Refuses once mail has gone out against the segment. `sends.segment_id` is
   * the only record of who a blast went to as a group; deleting the segment
   * would null it and quietly break the audit trail Terra needs if a customer
   * rings up asking what they were sent and why.
   */
  remove: adminOnly.input(z.object({ id: z.number().int() })).handler(async ({ input }) => {
    const [sent] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.sends)
      .where(eq(schema.sends.segmentId, input.id));

    if (Number(sent?.n ?? 0) > 0) {
      throw new ORPCError("CONFLICT", {
        message: `${sent!.n} message(s) were sent to this segment, so it is part of the send history and cannot be deleted. Rename it instead.`,
      });
    }

    await db.delete(schema.segments).where(eq(schema.segments.id, input.id));
    return { deleted: true };
  }),

  /* -------------------------------------------------------------------------
   * Audience review
   *
   * The homeowner/trade split is a heuristic, and a heuristic that decides who
   * gets marketing email needs a human override. These two procedures are that
   * override: the queue lists contacts the heuristic thinks are trade but
   * nobody has confirmed, and `setAudience` records the decision, which then
   * beats the heuristic forever.
   *
   * Until a contact is reviewed it is held back from journeys, not mailed. Not
   * sending to a homeowner is recoverable; mailing a builder Terra
   * subcontracts for is not.
   * ----------------------------------------------------------------------- */

  audienceReview: {
    queue: adminOnly
      .input(z.object({ limit: z.number().int().min(1).max(500).default(200) }).default({ limit: 200 }))
      .handler(async ({ input }) => {
        const rows = await tradeReviewQueue(input.limit);
        const [totals] = await db
          .select({
            unknown: sql<number>`sum(case when ${schema.contacts.audienceKind} = 'unknown' then 1 else 0 end)`,
            homeowner: sql<number>`sum(case when ${schema.contacts.audienceKind} = 'homeowner' then 1 else 0 end)`,
            trade: sql<number>`sum(case when ${schema.contacts.audienceKind} = 'trade' then 1 else 0 end)`,
          })
          .from(schema.contacts);

        return {
          rows,
          totals: {
            unknown: Number(totals?.unknown ?? 0),
            homeowner: Number(totals?.homeowner ?? 0),
            trade: Number(totals?.trade ?? 0),
          },
        };
      }),

    /** Records the human decision. A confirmed homeowner is mailable again. */
    setAudience: adminOnly
      .input(
        z.object({
          contactId: z.number().int(),
          audienceKind: z.enum(["homeowner", "trade", "unknown"]),
        }),
      )
      .handler(async ({ input }) => {
        const [contact] = await db
          .select({ id: schema.contacts.id, email: schema.contacts.email })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, input.contactId));
        if (!contact) throw new ORPCError("NOT_FOUND", { message: "Contact not found" });

        await db
          .update(schema.contacts)
          .set({ audienceKind: input.audienceKind, updatedAt: new Date() })
          .where(eq(schema.contacts.id, input.contactId));

        return { id: input.contactId, audienceKind: input.audienceKind };
      }),

    /** Why the heuristic thinks what it thinks, for one contact. */
    signals: adminOnly
      .input(z.object({ contactId: z.number().int() }))
      .handler(async ({ input }) => {
        const [contact] = await db
          .select({
            id: schema.contacts.id,
            firstName: schema.contacts.firstName,
            lastName: schema.contacts.lastName,
            email: schema.contacts.email,
            audienceKind: schema.contacts.audienceKind,
          })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, input.contactId));
        if (!contact) throw new ORPCError("NOT_FOUND", { message: "Contact not found" });

        const signals = await signalsFor(input.contactId);
        return {
          contact,
          signals,
          reasons: tradeReasons(signals, contact.email),
        };
      }),
  },
};
