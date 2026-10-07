import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { addQuotePerson, listQuotePeople, personInput, updateQuotePerson } from "../lib/job-people";
import { PERSON_TAGS, COMPANY_TYPES, parseTags } from "../lib/person-tags";
import { duplicateGroups, findMatches, mergeContacts } from "../lib/contact-merge";
import { referrers } from "../lib/referrals";

/**
 * People on quotes, the "already exists" check, the duplicate review list,
 * company retyping and the Referrers report. Job people live on jobs.ts.
 */

async function editableQuote(quoteId: number) {
  const [q] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!q) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
  if (q.status === "accepted") throw new ORPCError("BAD_REQUEST", { message: "This quote is accepted. Add people on the job instead." });
  return q;
}

const SUPERVISOR_ON_QUOTE = "Pick the supervisor in the Supervisor box above. A quote has at most one.";

/** Names that read like a real estate agency or property manager. A suggestion only. */
const REAL_ESTATE = /\b(real\s*estate|realty|property|properties|realestate|ray\s*white|lj\s*hooker|harcourts|belle|mcgrath|century\s*21|first\s*national|raine|remax|re\/max|prd|richardson|place\s+estate|rentals?|strata|body\s*corp)/i;
const INSURER = /\b(insurance|insurer|suncorp|aami|allianz|nrma|qbe|youi|racq|budget\s*direct|cgu|gio|hollard|claims?)\b/i;

export const people = {
  quoteList: staffOnly.input(z.object({ quoteId: z.number() })).handler(({ input }) => listQuotePeople(input.quoteId)),

  quoteAdd: staffOnly
    .input(personInput.extend({ quoteId: z.number() }))
    .handler(async ({ input }) => {
      await editableQuote(input.quoteId);
      if (input.tags.includes("supervisor")) throw new ORPCError("BAD_REQUEST", { message: SUPERVISOR_ON_QUOTE });
      const { quoteId, contactId, ...rest } = input;
      const row = await addQuotePerson(quoteId, contactId, rest);
      return { ...row, tags: parseTags(row.tags) };
    }),

  quoteUpdate: staffOnly
    .input(
      z.object({
        id: z.number(),
        tags: z.array(z.enum(PERSON_TAGS)).min(1, "Pick at least one tag").optional(),
        onSiteContact: z.boolean().optional(),
        canApproveQuote: z.boolean().optional(),
        receivesSms: z.boolean().optional(),
        receivesEmail: z.boolean().optional(),
        showToCrew: z.boolean().optional(),
        whenToContact: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const [link] = await db.select().from(schema.quoteContacts).where(eq(schema.quoteContacts.id, input.id));
      if (!link) throw new ORPCError("NOT_FOUND", { message: "That person is not on this quote" });
      await editableQuote(link.quoteId);
      if (input.tags?.includes("supervisor")) throw new ORPCError("BAD_REQUEST", { message: SUPERVISOR_ON_QUOTE });
      const { id, ...rest } = input;
      const row = await updateQuotePerson(id, rest);
      return row ? { ...row, tags: parseTags(row.tags) } : null;
    }),

  quoteRemove: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [link] = await db.select().from(schema.quoteContacts).where(eq(schema.quoteContacts.id, input.id));
    if (!link) return { ok: true };
    await editableQuote(link.quoteId);
    await db.delete(schema.quoteContacts).where(eq(schema.quoteContacts.id, input.id));
    return { ok: true };
  }),

  /** "Marcos Brancea already has this mobile. Use that card?" Asked before a new card is saved. */
  matches: staffOnly
    .input(
      z.object({
        mobile: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        firstName: z.string().nullable().optional(),
        lastName: z.string().nullable().optional(),
        excludeId: z.number().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const found = await findMatches(input);
      return found.map((f) => ({
        id: f.contact.id,
        name: `${f.contact.firstName} ${f.contact.lastName}`.trim(),
        mobile: f.contact.mobile,
        email: f.contact.email,
        suburb: f.contact.suburb,
        reasons: f.reasons,
      }));
    }),

  /** Cards that look like the same person, for the review list. */
  duplicates: adminOnly.handler(() => duplicateGroups()),

  /** Merge one pair: everything moves to `keepId`, `dropId` is archived. */
  merge: adminOnly
    .input(z.object({ keepId: z.number(), dropId: z.number() }))
    .handler(async ({ input, context }) => {
      try {
        return await mergeContacts(input.keepId, input.dropId, context.actor);
      } catch (e) {
        if (e instanceof ORPCError) throw e;
        throw new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : "Merge failed" });
      }
    }),

  /**
   * Every company with its type and a suggested type when the name reads like
   * a real estate agency or an insurer. Retyping goes through companies.update.
   */
  companyTypes: staffOnly.handler(async () => {
    const rows = await db.all<{ id: number; name: string; type: string; jobs: number; people: number; deposit_percent: number | null }>(sql`
      select co.id, co.name, co.type, co.deposit_percent,
        (select count(*) from jobs j where j.company_id = co.id) as jobs,
        (select count(*) from company_contacts cc where cc.company_id = co.id) as people
      from companies co where co.active = 1 order by co.name collate nocase`);
    return rows.map((r) => {
      const suggested = INSURER.test(r.name) ? "insurer" : REAL_ESTATE.test(r.name) ? "real_estate" : null;
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        jobs: Number(r.jobs),
        people: Number(r.people),
        depositPercent: r.deposit_percent,
        suggested: suggested && suggested !== r.type && !(suggested === "real_estate" && r.type === "property_manager") ? suggested : null,
      };
    });
  }),

  companyTypeList: staffOnly.handler(() => COMPANY_TYPES),

  /** People and Companies that send work: total quoted and total invoiced, ex GST. Admin and Office. */
  referrers: staffOnly
    .input(
      z
        .object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        })
        .default({}),
    )
    .handler(({ input }) => referrers(input)),
};
