import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { COMPANY_TYPES } from "./person-tags";

/**
 * RECORDS MADE ON THE NEW JOB SCREEN.
 *
 * The New job screen lets the office make a contact, a company, a supervisor,
 * a site and any job contacts without leaving it. Nothing is written while the
 * form is open: everything travels with "Create job" and is made here, first,
 * so a cancelled form leaves nothing behind.
 *
 * Every record made here is a normal full record, exactly as if it had been
 * made from its own page: a contact is a `contacts` card, filed under a
 * company through `company_contacts` when asked; a company is a `companies`
 * row; a site is a `sites` row owned by the job's contact and company.
 *
 * New people are referred to by a `key` the screen chose (for example "n3"),
 * because they have no id until they are saved. Anywhere createJob takes a
 * contact id it also takes that key.
 */

const optText = z
  .string()
  .trim()
  .nullable()
  .optional()
  .transform((v) => (v ? v : null));

export const newContactInput = z.object({
  /** The screen's own handle for this person until they have an id. */
  key: z.string().min(1).max(40),
  firstName: z.string().trim().min(1, "A first name is needed for every new person."),
  lastName: z.string().trim().default(""),
  mobile: optText,
  /** Office or landline. */
  phone: optText,
  email: optText,
  address: optText,
  suburb: optText,
  postcode: optText,
  notes: optText,
  source: z.string().default("other"),
  marketingOptIn: z.boolean().default(false),
  /** File them under the job's company (picked or new) at `companyRole`. */
  atCompany: z.boolean().default(false),
  companyRole: z.string().default("other"),
  /** Their job title at that company, e.g. "Site supervisor". */
  jobTitle: optText,
});

export const newCompanyInput = z.object({
  name: z.string().trim().min(1, "The new company needs a name."),
  type: z.enum(COMPANY_TYPES).default("builder"),
  abn: optText,
  phone: optText,
  email: optText,
  website: optText,
  billingAddress: optText,
  paymentTerms: z.number().int().min(0).default(14),
  notes: optText,
});

export const newSiteInput = z.object({
  label: optText,
  address: z.string().trim().min(1, "The new site needs a street address."),
  suburb: z.string().trim().default(""),
  state: z.string().trim().default("QLD"),
  postcode: optText,
  propertyType: z.string().default("residential"),
  /** Lockbox, gate code, parking. Kept on the site for every future job there. */
  accessNotes: optText,
  notes: optText,
});

export type NewContact = z.output<typeof newContactInput>;
export type NewCompany = z.output<typeof newCompanyInput>;
export type NewSite = z.output<typeof newSiteInput>;

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

/** Checks a set of new records hang together before anything is written. Throws plain English. */
export function checkNewRecords(args: {
  newContacts: NewContact[];
  newCompany: NewCompany | null | undefined;
  companyId: number | null | undefined;
  newSite: NewSite | null | undefined;
  siteId: number | null | undefined;
  /** Every key the job refers to: contact, supervisor, bill-to, people. */
  usedKeys: string[];
}) {
  const keys = new Set<string>();
  for (const c of args.newContacts) {
    if (keys.has(c.key)) throw bad("The same new person was sent twice. Refresh the screen and try again.");
    keys.add(c.key);
  }
  for (const k of args.usedKeys) {
    if (!keys.has(k)) throw bad("A new person on this job is missing their details. Add them again.");
  }
  if (args.newCompany && args.companyId) throw bad("Pick an existing company or make a new one, not both.");
  if (args.newSite && args.siteId) throw bad("Pick an existing site or type a new address, not both.");
  const hasCompany = !!args.newCompany || !!args.companyId;
  if (!hasCompany && args.newContacts.some((c) => c.atCompany)) {
    throw bad("Someone is set to work at the company, but there is no company on this job.");
  }
}

/**
 * Writes the new company, people and site, in that order, and returns their
 * ids. Call `checkNewRecords` first. `ownerContact` picks which person owns a
 * new site: the job's own contact, by id or by key.
 */
export async function createNewRecords(args: {
  newContacts: NewContact[];
  newCompany: NewCompany | null | undefined;
  companyId: number | null | undefined;
  newSite: NewSite | null | undefined;
  ownerContact: { id?: number | null; key?: string | null };
  actor: { name: string; role: string };
}) {
  const made: string[] = [];

  let companyId = args.companyId ?? null;
  if (args.newCompany) {
    const [co] = await db.insert(schema.companies).values(args.newCompany).returning();
    companyId = co!.id;
    made.push(`company ${co!.name}`);
  }

  const ids = new Map<string, number>();
  for (const c of args.newContacts) {
    const { key, atCompany, companyRole, jobTitle, ...values } = c;
    const [row] = await db.insert(schema.contacts).values(values).returning();
    ids.set(key, row!.id);
    // The same history line the Clients page writes for a new card.
    await db.insert(schema.activityLog).values({
      contactId: row!.id,
      entityType: "contact",
      entityId: row!.id,
      action: "created",
      detail: `${row!.firstName} ${row!.lastName}`.trim(),
      actorName: args.actor.name,
      actorRole: args.actor.role,
    });
    if (atCompany && companyId) {
      await db
        .insert(schema.companyContacts)
        .values({ companyId, contactId: row!.id, role: companyRole, jobTitle })
        .onConflictDoNothing();
    }
    made.push(`${companyRole === "supervisor" && atCompany ? "supervisor" : "contact"} ${`${row!.firstName} ${row!.lastName}`.trim()}`);
  }

  let siteId: number | null = null;
  if (args.newSite) {
    const owner = args.ownerContact.id ?? (args.ownerContact.key ? (ids.get(args.ownerContact.key) ?? null) : null);
    const [site] = await db
      .insert(schema.sites)
      .values({ ...args.newSite, contactId: owner, companyId })
      .returning();
    siteId = site!.id;
    made.push(`site ${site!.address}`);
  }

  return { companyId, contactIds: ids, siteId, made };
}
