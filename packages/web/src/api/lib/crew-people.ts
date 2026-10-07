import { inArray } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { PERSON_TAG_SHORT, parseTags } from "./person-tags";

/**
 * WHO CREW SEES ON A JOB.
 *
 * Only people the office ticked Show to Crew on this job, chosen job by job.
 * Any tag can be shown, Supervisor and Tenant included. Crew gets the name, a
 * number to ring, the tags on this job, the Site access and Decision-maker
 * ticks and the "when to contact" note. Never the billing company, a price,
 * a cost or a referral figure. A job with nobody ticked shows Crew nobody.
 */
export interface CrewPerson {
  name: string;
  firstName: string;
  mobile: string | null;
  phone: string | null;
  siteAccess: boolean;
  decisionMaker: boolean;
  whenToContact: string | null;
  /** Tag names on this job, for example ["Tenant"] or ["Supervisor"]. */
  tags: string[];
  /** Tags then the ticks, for example "Tenant · Site access", for the label under the name. */
  label: string;
  /** Kept for older app builds, which print it under the name. Same text as `label`. */
  role: string;
  onSite: boolean;
}

export async function crewPeopleFor(jobIds: number[]): Promise<Map<number, CrewPerson[]>> {
  const out = new Map<number, CrewPerson[]>();
  if (jobIds.length === 0) return out;
  const rows = await db
    .select({
      jobId: schema.jobContacts.jobId,
      tags: schema.jobContacts.tags,
      onSite: schema.jobContacts.onSiteContact,
      approve: schema.jobContacts.canApproveQuote,
      show: schema.jobContacts.showToCrew,
      isPrimary: schema.jobContacts.isPrimary,
      note: schema.jobContacts.whenToContact,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
      mobile: schema.contacts.mobile,
      phone: schema.contacts.phone,
    })
    .from(schema.jobContacts)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.jobContacts.contactId))
    .where(inArray(schema.jobContacts.jobId, jobIds));

  const ranked = rows
    .filter((r) => r.show)
    // Site access first, then someone with a mobile, then the primary person.
    .sort((a, b) => Number(b.onSite) - Number(a.onSite) || Number(!!b.mobile) - Number(!!a.mobile) || Number(b.isPrimary) - Number(a.isPrimary));

  for (const r of ranked) {
    const tags = parseTags(r.tags).map((t) => PERSON_TAG_SHORT[t]);
    const label = [...tags, r.onSite ? "Site access" : null, r.approve ? "Decision-maker" : null].filter(Boolean).join(" · ");
    const person: CrewPerson = {
      name: `${r.firstName} ${r.lastName}`.trim(),
      firstName: r.firstName.trim(),
      mobile: r.mobile,
      phone: r.phone,
      siteAccess: !!r.onSite,
      decisionMaker: !!r.approve,
      whenToContact: r.note?.trim() || null,
      tags,
      label,
      role: label,
      onSite: !!r.onSite,
    };
    const list = out.get(r.jobId) ?? [];
    list.push(person);
    out.set(r.jobId, list);
  }
  return out;
}
