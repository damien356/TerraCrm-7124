import { z } from "zod";
import { and, asc, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { COMPANY_TYPES } from "../lib/person-tags";

/**
 * The ServiceM8 import review queue.
 *
 * ServiceM8 let a client be a company, a private client, or neither. The
 * "neither" pile came across flagged `needsReview` with no marketing basis, so
 * nothing in it can be marketed to until Damien says what it is. This route is
 * that sorting screen, plus the small amount of logic each decision carries.
 */

/**
 * Damien's chosen recency cutoff. A finished job older than this is not a
 * strong enough relationship to lean on for inferred consent, so the record
 * keeps its history and stays out of any campaign.
 */
const MARKETING_CUTOFF = new Date("2023-01-01T00:00:00Z");

/** Shared mailboxes. A blast to one of these lands in front of the wrong people. */
const ROLE_LOCAL_PARTS = new Set([
  "info",
  "admin",
  "accounts",
  "sales",
  "office",
  "estimating",
  "enquiries",
  "enquiry",
  "reception",
  "manager",
  "maintenance",
  "service",
  "support",
  "contact",
  "mail",
  "rentals",
  "property",
  "properties",
  "bookings",
]);

const isRoleEmail = (email: string | null) => {
  if (!email) return false;
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return ROLE_LOCAL_PARTS.has(local) || /^(estimating|accounts|admin|info|rentals)\d*$/.test(local);
};

/**
 * What a person may be marketed on once they are confirmed a homeowner. A
 * completed job inside the cutoff is the basis; no reachable contact detail, or
 * only a shared mailbox and no mobile, means no basis at all.
 */
function homeownerBasis(contact: { email: string | null; mobile: string | null; lastCompletedAt: Date | null }) {
  const hasMobile = Boolean(contact.mobile);
  const hasEmail = Boolean(contact.email);
  if (!hasMobile && !hasEmail) return { basis: "none", note: "no email or mobile, cannot be marketed to" };
  if (!contact.lastCompletedAt) return { basis: "none", note: "no completed job, no basis to market on" };
  if (contact.lastCompletedAt < MARKETING_CUTOFF)
    return { basis: "none", note: "last completed job is before the 2023 cutoff" };
  if (!hasMobile && isRoleEmail(contact.email))
    return { basis: "none", note: "only a shared mailbox and no mobile, held back" };
  if (hasMobile && isRoleEmail(contact.email))
    return { basis: "completed_job", note: "shared mailbox, text this one rather than email" };
  return { basis: "completed_job", note: null as string | null };
}

const appendNote = (existing: string | null, line: string) =>
  existing && existing.trim() ? `${existing.trim()}\n${line}` : line;

/** Undo has to take the review notes back off too, or the record reads as already sorted. */
const stripReviewNotes = (existing: string | null) => {
  const kept = (existing ?? "")
    .split("\n")
    .filter((line) => !line.trim().toLowerCase().startsWith("reviewed:"))
    .join("\n")
    .trim();
  return kept ? kept : null;
};

export const review = {
  /** Headline numbers for the review screen and the dashboard. */
  stats: adminOnly.handler(async () => {
    const [row] = await db
      .select({
        contactsAwaiting: sql<number>`(select count(*) from contacts where needs_review = 1)`,
        companiesAwaiting: sql<number>`(select count(*) from companies where needs_review = 1)`,
        marketable: sql<number>`(
          select count(*) from contacts where marketing_basis != 'none' and do_not_market = 0 and active = 1
        )`,
        blockedContacts: sql<number>`(select count(*) from contacts where do_not_market = 1)`,
        blockedCompanies: sql<number>`(select count(*) from companies where do_not_market = 1)`,
        importedContacts: sql<number>`(select count(*) from contacts where external_ref is not null)`,
        importedCompanies: sql<number>`(select count(*) from companies where external_ref is not null)`,
        importedJobs: sql<number>`(select count(*) from jobs where external_ref is not null)`,
      })
      .from(sql`(select 1)`);

    return {
      contactsAwaiting: Number(row?.contactsAwaiting ?? 0),
      companiesAwaiting: Number(row?.companiesAwaiting ?? 0),
      marketable: Number(row?.marketable ?? 0),
      blockedContacts: Number(row?.blockedContacts ?? 0),
      blockedCompanies: Number(row?.blockedCompanies ?? 0),
      importedContacts: Number(row?.importedContacts ?? 0),
      importedCompanies: Number(row?.importedCompanies ?? 0),
      importedJobs: Number(row?.importedJobs ?? 0),
      cutoff: MARKETING_CUTOFF,
    };
  }),

  /**
   * The queue itself. Biggest job history first, because those are the records
   * worth Damien's attention and the ones a wrong call costs the most on.
   */
  queue: adminOnly
    .input(
      z
        .object({
          search: z.string().optional(),
          /** Flip to see what has already been sorted, so a call can be undone. */
          resolved: z.boolean().default(false),
          sort: z.enum(["jobs", "recent", "name"]).default("jobs"),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .default({ resolved: false, sort: "jobs", limit: 100 }),
    )
    .handler(async ({ input }) => {
      const where: SQL[] = [eq(schema.contacts.needsReview, !input.resolved)];
      // The sorted view means records a human actually ruled on, not the
      // 1,500 that came across already classified.
      if (input.resolved)
        where.push(
          sql`exists (select 1 from activity_log al where al.contact_id = contacts.id and al.action like 'review_%')`,
        );
      if (input.search) {
        const q = `%${input.search.toLowerCase()}%`;
        where.push(
          or(
            like(sql`lower(${schema.contacts.firstName})`, q),
            like(sql`lower(${schema.contacts.lastName})`, q),
            like(sql`lower(coalesce(${schema.contacts.email}, ''))`, q),
            like(sql`lower(coalesce(${schema.contacts.externalRef}, ''))`, q),
            like(sql`coalesce(${schema.contacts.mobile}, '')`, `%${input.search}%`),
            like(sql`lower(coalesce(${schema.contacts.suburb}, ''))`, q),
          )!,
        );
      }

      const rows = await db
        .select({
          contact: schema.contacts,
          jobCount: sql<number>`(select count(*) from jobs j where j.contact_id = contacts.id)`,
          // A finished job is one with a completion date on it. Status is no use
          // here, the import splits finished work across Complete, Invoiced and Paid.
          completedCount: sql<number>`(
            select count(*) from jobs j where j.contact_id = contacts.id and j.completed_at is not null
          )`,
          jobValue: sql<number>`(select coalesce(sum(j.value), 0) from jobs j where j.contact_id = contacts.id)`,
          lastJobTitle: sql<string>`(
            select j.title from jobs j where j.contact_id = contacts.id
            order by coalesce(j.completed_at, j.scheduled_start, 0) desc limit 1
          )`,
          suburbs: sql<string>`(
            select group_concat(distinct s.suburb) from sites s where s.contact_id = contacts.id
          )`,
          companyNames: sql<string>`(
            select group_concat(c.name, ', ') from company_contacts cc
            join companies c on c.id = cc.company_id
            where cc.contact_id = contacts.id
          )`,
          /** The call that was made last, so the sorted view can show it. */
          lastDecision: sql<string>`(
            select al.action from activity_log al
            where al.contact_id = contacts.id and al.action like 'review_%'
            order by al.id desc limit 1
          )`,
        })
        .from(schema.contacts)
        .where(and(...where))
        .orderBy(
          ...(input.resolved && input.sort !== "name"
            ? [desc(schema.contacts.updatedAt)]
            : input.sort === "name"
            ? [asc(schema.contacts.firstName), asc(schema.contacts.lastName)]
            : input.sort === "recent"
              ? [desc(schema.contacts.lastCompletedAt)]
              : [desc(sql`(select count(*) from jobs j where j.contact_id = contacts.id)`)]),
        )
        .limit(input.limit);

      return rows.map((r) => ({
        ...r.contact,
        jobCount: Number(r.jobCount ?? 0),
        completedCount: Number(r.completedCount ?? 0),
        jobValue: Number(r.jobValue ?? 0),
        lastJobTitle: r.lastJobTitle ?? "",
        suburbs: r.suburbs ?? "",
        companyNames: r.companyNames ?? "",
        lastDecision: (r.lastDecision ?? "").replace("review_", ""),
        /** What the homeowner call would do, shown on the card before he clicks. */
        wouldMarket: homeownerBasis(r.contact).basis !== "none",
      }));
    }),

  /**
   * Record Damien's decision on one or many flagged records.
   *
   *   homeowner  a private client. Marketing basis is worked out, not assumed.
   *   business   a company. A company record is created or reused, the person
   *              is linked to it, and their jobs move across to it.
   *   block      real client, never market to them. Outranks everything.
   *   archive    not a client at all. Kept for history, out of every list.
   *   reopen     undo, put it back in the queue.
   */
  resolve: adminOnly
    .input(
      z.object({
        ids: z.array(z.number().int()).min(1).max(200),
        decision: z.enum(["homeowner", "business", "block", "archive", "reopen"]),
        /** Only used by block and archive. */
        reason: z.string().nullable().optional(),
        /** Only used by business. */
        companyType: z.enum(COMPANY_TYPES).default("builder"),
        /**
         * Only used by business, and only sensible one record at a time. Lets him
         * correct the ServiceM8 name before it becomes the company name. Blank
         * falls back to the ServiceM8 name on the record.
         */
        companyName: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const rows = await db.select().from(schema.contacts).where(inArray(schema.contacts.id, input.ids));
      const results: { id: number; name: string; outcome: string }[] = [];

      for (const contact of rows) {
        const name = `${contact.firstName} ${contact.lastName}`.trim();
        let outcome = "";

        if (input.decision === "homeowner") {
          const { basis, note } = homeownerBasis(contact);
          await db
            .update(schema.contacts)
            .set({
              needsReview: false,
              marketingBasis: basis,
              source: contact.source === "other" ? "repeat" : contact.source,
              notes: appendNote(contact.notes, `Reviewed: private homeowner.${note ? ` ${note}.` : ""}`),
              updatedAt: new Date(),
            })
            .where(eq(schema.contacts.id, contact.id));
          outcome = basis === "none" ? `homeowner, no marketing basis (${note})` : "homeowner, marketable";
        }

        if (input.decision === "business") {
          // The ServiceM8 client name is the business ("Coffee Boy West End"),
          // the contact row is the person who answers the phone ("Sam").
          const companyName = (
            (input.ids.length === 1 ? input.companyName?.trim() : "") ||
            contact.externalRef?.trim() ||
            name ||
            "Unnamed business"
          ).slice(0, 120);
          const [existing] = await db
            .select()
            .from(schema.companies)
            .where(eq(sql`lower(${schema.companies.name})`, companyName.toLowerCase()));

          const company =
            existing ??
            (
              await db
                .insert(schema.companies)
                .values({
                  name: companyName,
                  type: input.companyType,
                  phone: contact.phone ?? contact.mobile ?? null,
                  email: contact.email ?? null,
                  billingAddress: [contact.address, contact.suburb, contact.postcode].filter(Boolean).join(", ") || null,
                  notes: `Created from the ServiceM8 review queue, off ${name || companyName}.`,
                  externalRef: contact.externalRef,
                })
                .returning()
            )[0]!;

          await db
            .insert(schema.companyContacts)
            .values({ companyId: company.id, contactId: contact.id, role: "owner", isPrimary: true })
            .onConflictDoNothing();

          // The work belongs to the business now, and so does the invoice.
          await db
            .update(schema.jobs)
            .set({ companyId: company.id, billToType: "company", billToCompanyId: company.id, updatedAt: new Date() })
            .where(eq(schema.jobs.contactId, contact.id));

          await db
            .update(schema.sites)
            .set({ companyId: company.id, propertyType: "commercial" })
            .where(eq(schema.sites.contactId, contact.id));

          await db
            .update(schema.contacts)
            .set({
              needsReview: false,
              marketingBasis: "none",
              source: "builder",
              notes: appendNote(contact.notes, `Reviewed: works for ${company.name}, business not a homeowner.`),
              updatedAt: new Date(),
            })
            .where(eq(schema.contacts.id, contact.id));

          outcome = existing ? `linked to existing ${company.name}` : `new company ${company.name}`;
        }

        if (input.decision === "block") {
          await db
            .update(schema.contacts)
            .set({
              needsReview: false,
              doNotMarket: true,
              doNotMarketReason: input.reason?.trim() || "Damien's call, no marketing",
              marketingBasis: "none",
              marketingOptIn: false,
              notes: appendNote(contact.notes, `Reviewed: blocked from marketing. ${input.reason?.trim() ?? ""}`.trim()),
              updatedAt: new Date(),
            })
            .where(eq(schema.contacts.id, contact.id));
          outcome = "blocked from marketing";
        }

        if (input.decision === "archive") {
          await db
            .update(schema.contacts)
            .set({
              needsReview: false,
              active: false,
              doNotMarket: true,
              doNotMarketReason: input.reason?.trim() || "Not a client",
              marketingBasis: "none",
              notes: appendNote(contact.notes, `Reviewed: not a client, archived. ${input.reason?.trim() ?? ""}`.trim()),
              updatedAt: new Date(),
            })
            .where(eq(schema.contacts.id, contact.id));
          outcome = "archived";
        }

        if (input.decision === "reopen") {
          // Undo has to undo the business call too, or a misclick leaves a
          // company nobody asked for holding the person's whole job history.
          const links = await db
            .select({ link: schema.companyContacts, company: schema.companies })
            .from(schema.companyContacts)
            .innerJoin(schema.companies, eq(schema.companies.id, schema.companyContacts.companyId))
            .where(eq(schema.companyContacts.contactId, contact.id));

          const madeHere = links.find((l) => (l.company.notes ?? "").includes("ServiceM8 review queue"));
          if (madeHere) {
            await db
              .update(schema.jobs)
              .set({
                companyId: null,
                billToType: "contact",
                billToCompanyId: null,
                billToContactId: contact.id,
                updatedAt: new Date(),
              })
              .where(eq(schema.jobs.companyId, madeHere.company.id));
            await db
              .update(schema.sites)
              .set({ companyId: null, propertyType: "residential" })
              .where(eq(schema.sites.companyId, madeHere.company.id));
            await db.delete(schema.companyContacts).where(eq(schema.companyContacts.companyId, madeHere.company.id));
            await db.delete(schema.companies).where(eq(schema.companies.id, madeHere.company.id));
          }

          await db
            .update(schema.contacts)
            .set({
              needsReview: true,
              marketingBasis: "none",
              doNotMarket: false,
              doNotMarketReason: null,
              active: true,
              // Everything in the queue came off the import as "other". Putting a
              // record back means putting that back too, notes included.
              source: "other",
              notes: stripReviewNotes(contact.notes),
              updatedAt: new Date(),
            })
            .where(eq(schema.contacts.id, contact.id));
          outcome = "back in the queue";
        }

        await db.insert(schema.activityLog).values({
          contactId: contact.id,
          entityType: "contact",
          entityId: contact.id,
          action: `review_${input.decision}`,
          detail: `${name || contact.externalRef || "record"}: ${outcome}`,
          actorName: context.actor.name,
          actorRole: context.actor.role,
        });

        results.push({ id: contact.id, name, outcome });
      }

      return { resolved: results.length, results };
    }),

  /** Flip the hard marketing block on a company, e.g. a builder that went broke. */
  setCompanyBlock: adminOnly
    .input(
      z.object({
        id: z.number().int(),
        doNotMarket: z.boolean(),
        reason: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db
        .update(schema.companies)
        .set({
          doNotMarket: input.doNotMarket,
          doNotMarketReason: input.doNotMarket ? input.reason?.trim() || "Damien's call, no marketing" : null,
          needsReview: false,
          updatedAt: new Date(),
        })
        .where(eq(schema.companies.id, input.id))
        .returning();
      return row;
    }),
};
