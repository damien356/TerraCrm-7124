import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { COMPANY_TYPE_LABELS, parseTags } from "./person-tags";
import { normaliseMobile } from "./sms";

/* ---------------------------------------------------------------------------
 * CUSTOMER COMMUNICATIONS: who is on a job, in what role, and may they get
 * this message (Damien, 31 Oct).
 *
 * Rules:
 *   - Every recipient is picked and approved by a person. Nothing here ever
 *     picks someone else because the first choice is missing. No fallback
 *     addresses, no company inbox, nobody hidden.
 *   - What was approved is saved as a snapshot (the person's email, mobile and
 *     tags on the job, plus the job's company and type). If any of it changes,
 *     the message goes back to Awaiting approval with the reason.
 *   - A homeowner on a builder or insurance job needs "Builder has OK'd direct
 *     contact" ticked on the job.
 *   - A direct customer is a Customer, not assumed to be a Homeowner. Only an
 *     Owner or Landlord tag makes someone a Homeowner.
 * ------------------------------------------------------------------------- */

export type CustomerType = "direct" | "builder" | "insurance" | "property_manager" | "real_estate" | "commercial";

export const CUSTOMER_TYPE_LABELS: Record<CustomerType, string> = {
  direct: "Direct customer",
  builder: "Normal builder",
  insurance: "Insurance builder",
  property_manager: "Property manager",
  real_estate: "Real estate agency",
  commercial: "Commercial",
};

/**
 * The job's company type, as a customer type. Property manager, real estate and
 * commercial follow the normal builder rules with wording for their role.
 * Government, retail and other companies use the commercial wording. An
 * insurer billed directly is treated as insurance.
 */
export function customerTypeOf(companyType: string | null | undefined, hasCompany: boolean): CustomerType {
  if (!hasCompany) return "direct";
  switch (companyType) {
    case "insurance_builder":
    case "insurer":
      return "insurance";
    case "builder":
      return "builder";
    case "property_manager":
      return "property_manager";
    case "real_estate":
      return "real_estate";
    default:
      return "commercial";
  }
}

/** Any type but direct: the builder rules apply (homeowner only with direct contact OK'd). */
export const isCompanyType = (t: CustomerType) => t !== "direct";

export type CommsRole = "billing" | "supervisor" | "homeowner" | "customer" | "tenant" | "property_manager" | "other";

export const ROLE_LABELS: Record<CommsRole, string> = {
  billing: "Billing",
  supervisor: "Builder supervisor / job contact",
  homeowner: "Homeowner",
  customer: "Customer",
  tenant: "Tenant / site contact",
  property_manager: "Property manager",
  other: "Other",
};

/** Tags that rule a person out as the homeowner even if they are also tagged Owner (as lib/care-engine.ts). */
const NOT_HOMEOWNER_TAGS = new Set(["builder_contact", "property_manager", "accounts", "supervisor", "tenant"]);

export type JobPerson = {
  contactId: number;
  name: string;
  firstName: string;
  email: string;
  /** The mobile as typed, and as a valid AU mobile or null. */
  mobileRaw: string;
  mobile: string | null;
  tags: string[];
  roles: CommsRole[];
  /** "Homeowner", or "Billing, Builder supervisor / job contact". */
  roleLabel: string;
  /** The main role, for wording and the confirm line. */
  mainRole: CommsRole;
  company: string | null;
  /** On the job's People list. The job client of an old job may not be. */
  onJob: boolean;
  receivesEmail: boolean;
  receivesSms: boolean;
  isClient: boolean;
  isBillTo: boolean;
};

export type JobCommsContext = {
  job: typeof schema.jobs.$inferSelect;
  jobRef: string;
  company: { id: number; name: string; type: string; email: string | null; workOrderPrefix: string | null } | null;
  type: CustomerType;
  typeLabel: string;
  people: JobPerson[];
  /** The bill-to company, shown on the Billing line. Never a recipient. */
  billingCompany: { name: string; email: string | null } | null;
  site: { address: string; suburb: string; postcode: string | null } | null;
  /** "12 Smith St, Mermaid Waters", or "" when the job has no site. */
  siteAddress: string;
};

const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();

const ROLE_ORDER: CommsRole[] = ["homeowner", "customer", "supervisor", "property_manager", "tenant", "billing", "other"];

/** Everyone on a job with their roles, the job's customer type and site. Null when the job is gone. */
export async function jobComms(jobId: number): Promise<JobCommsContext | null> {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) return null;
  const companyId = job.companyId ?? job.billToCompanyId ?? null;
  const [co] = companyId ? await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)) : [];
  const [billCo] =
    job.billToCompanyId && job.billToCompanyId !== companyId ? await db.select().from(schema.companies).where(eq(schema.companies.id, job.billToCompanyId)) : [];
  const type = customerTypeOf(co?.type, !!co);
  const [site] = job.siteId ? await db.select().from(schema.sites).where(eq(schema.sites.id, job.siteId)) : [];

  const links = await db
    .select({ link: schema.jobContacts, c: schema.contacts })
    .from(schema.jobContacts)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.jobContacts.contactId))
    .where(eq(schema.jobContacts.jobId, job.id))
    .orderBy(desc(schema.jobContacts.isPrimary), asc(schema.jobContacts.id));

  const extraIds = [job.contactId, job.billToContactId].filter((x): x is number => !!x && !links.some((l) => l.c.id === x));
  const extras = extraIds.length ? await db.select().from(schema.contacts).where(inArray(schema.contacts.id, extraIds)) : [];

  const allIds = [...links.map((l) => l.c.id), ...extras.map((c) => c.id)];
  const coLinks = allIds.length
    ? await db
        .select({ contactId: schema.companyContacts.contactId, name: schema.companies.name, companyId: schema.companies.id })
        .from(schema.companyContacts)
        .innerJoin(schema.companies, eq(schema.companies.id, schema.companyContacts.companyId))
        .where(inArray(schema.companyContacts.contactId, allIds))
    : [];
  const companyOf = (id: number) => (coLinks.find((l) => l.contactId === id && l.companyId === companyId) ?? coLinks.find((l) => l.contactId === id))?.name ?? null;

  const company = isCompanyType(type);
  const shape = (c: typeof schema.contacts.$inferSelect, link: typeof schema.jobContacts.$inferSelect | null): JobPerson => {
    const tags = link ? (parseTags(link.tags) as string[]) : [];
    const roles = new Set<CommsRole>();
    const isClient = job.contactId === c.id;
    const isBillTo = job.billToContactId === c.id;
    if (isBillTo || tags.includes("accounts")) roles.add("billing");
    if (tags.includes("supervisor") || tags.includes("builder_contact")) roles.add("supervisor");
    if ((tags.includes("owner") || tags.includes("landlord")) && !tags.some((t) => NOT_HOMEOWNER_TAGS.has(t))) roles.add("homeowner");
    if (tags.includes("property_manager")) roles.add("property_manager");
    if (tags.includes("tenant") || link?.onSiteContact) roles.add("tenant");
    /* A direct job's client with no other role is the Customer. Not assumed to be a homeowner. */
    if (!company && isClient && !roles.has("homeowner") && ![...roles].some((r) => r !== "billing")) roles.add("customer");
    if (!roles.size) roles.add("other");
    const ordered = ROLE_ORDER.filter((r) => roles.has(r));
    return {
      contactId: c.id,
      name: fullName(c) || "(no name)",
      firstName: (c.firstName ?? "").trim(),
      email: (c.email ?? "").trim().toLowerCase(),
      mobileRaw: (c.mobile ?? "").trim(),
      mobile: normaliseMobile(c.mobile),
      tags,
      roles: ordered,
      roleLabel: ordered.map((r) => ROLE_LABELS[r]).join(", "),
      mainRole: ordered[0]!,
      company: companyOf(c.id),
      onJob: !!link,
      /* An old job's client who is not on the People list has no flags set. They are not turned off. */
      receivesEmail: link ? !!link.receivesEmail : true,
      receivesSms: link ? !!link.receivesSms : true,
      isClient,
      isBillTo,
    };
  };

  const people = [...links.map((l) => shape(l.c, l.link)), ...extras.map((c) => shape(c, null))];
  const siteAddress = site ? [site.address, site.suburb].map((x) => (x ?? "").trim()).filter(Boolean).join(", ") : "";
  return {
    job,
    jobRef: job.displayNumber ?? String(job.number),
    company: co ? { id: co.id, name: co.name, type: co.type, email: co.email, workOrderPrefix: co.workOrderPrefix } : null,
    type,
    typeLabel: co ? `${CUSTOMER_TYPE_LABELS[type]}${type === "commercial" && co.type !== "commercial" ? ` (${COMPANY_TYPE_LABELS[co.type] ?? co.type})` : ""}` : CUSTOMER_TYPE_LABELS.direct,
    people,
    billingCompany: billCo ? { name: billCo.name, email: billCo.email } : co && job.billToType === "company" ? { name: co.name, email: co.email } : null,
    site: site ? { address: site.address, suburb: site.suburb, postcode: site.postcode } : null,
    siteAddress,
  };
}

/* ---------------------------------------------------------------------------
 * Who may get what
 * ------------------------------------------------------------------------- */

export type CommsPurpose = "followup" | "care_guide" | "care_series" | "review";

/** The roles that can be picked for each kind of message on each kind of job. */
export function rolesAllowed(purpose: CommsPurpose, type: CustomerType): CommsRole[] {
  if (purpose === "review" && type === "insurance") return ["homeowner"];
  if (purpose === "care_series") return ["homeowner", "customer"];
  if (type === "direct") return ["customer", "homeowner", "billing", "other", "property_manager", "supervisor"];
  if (purpose === "followup") return ["supervisor", "property_manager", "billing", "homeowner", "other"];
  /* Care guide and review on a company job: the supervisor or job contact, the property manager, or an authorised homeowner. */
  return ["supervisor", "property_manager", "homeowner"];
}

/** "Sarah Smith · Homeowner · sarah@example.com". Never "the customer". */
export const confirmLine = (p: Pick<JobPerson, "name" | "mainRole">, address: string) => `${p.name} · ${ROLE_LABELS[p.mainRole]} · ${address}`;

/** The last hard bounce to this address, with its date. */
const HARD_BOUNCE_RE = /bounce|does not exist|no such user|mailbox unavailable|invalid recipient|recipient address rejected|user unknown|\b550\b/i;
export async function bounceOf(email: string): Promise<{ at: Date; detail: string } | null> {
  if (!email) return null;
  const rows = await db
    .select({ detail: schema.messages.statusDetail, at: schema.messages.createdAt })
    .from(schema.messages)
    .where(and(eq(schema.messages.direction, "out"), eq(schema.messages.status, "failed"), sql`lower(${schema.messages.toAddress}) = ${email.toLowerCase()}`))
    .orderBy(desc(schema.messages.id))
    .limit(20);
  const hit = rows.find((r) => HARD_BOUNCE_RE.test(r.detail ?? ""));
  return hit ? { at: hit.at, detail: hit.detail ?? "" } : null;
}

/** An unsubscribe that covers this person on this channel. */
export async function optOutOf(p: Pick<JobPerson, "contactId" | "email" | "mobile">, channel: "email" | "sms") {
  const rows = await db
    .select({ channel: schema.unsubscribes.channel, at: schema.unsubscribes.createdAt })
    .from(schema.unsubscribes)
    .where(
      or(
        eq(schema.unsubscribes.contactId, p.contactId),
        p.email ? eq(schema.unsubscribes.email, p.email) : sql`0`,
        p.mobile ? eq(schema.unsubscribes.mobile, p.mobile) : sql`0`,
      ),
    );
  return rows.find((r) => r.channel === "all" || r.channel === channel) ?? null;
}

const auDay = (d: Date) => d.toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short", year: "numeric" });

/**
 * Why this person cannot get this message, with the fix in plain words, or
 * null when they can. Checked when the office picks them, at approval, and
 * again right before every send.
 */
export async function blockFor(ctx: JobCommsContext, p: JobPerson, purpose: CommsPurpose, channel: "email" | "sms"): Promise<string | null> {
  const first = p.firstName || p.name;
  const allowed = rolesAllowed(purpose, ctx.type);
  if (!p.roles.some((r) => allowed.includes(r))) {
    if (purpose === "review" && ctx.type === "insurance") return `On an insurance job only the homeowner can be asked for a review. ${first} is ${p.roleLabel}.`;
    return `${first} is ${p.roleLabel} on this job, which can't get this. Pick ${andOr(allowed.map((r) => ROLE_LABELS[r]))}.`;
  }
  const asHomeowner = p.roles.includes("homeowner") && !p.roles.some((r) => r === "supervisor" || r === "property_manager" || (purpose === "followup" && r === "billing"));
  if (isCompanyType(ctx.type) && asHomeowner && !ctx.job.directContactOk) {
    return `${first} is the homeowner on ${ctx.type === "insurance" ? "an insurance" : "a builder"} job. Tick "Builder has OK'd direct contact" first.`;
  }
  if (channel === "email") {
    if (!p.email) return `No email for ${first}. Add one on their card, or pick someone else.`;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return `${first}'s email "${p.email}" doesn't look right. Fix it on their card.`;
    if (!p.receivesEmail) return `${first} is set to not receive emails on this job. Tick Email on their line in People, or pick someone else.`;
    const b = await bounceOf(p.email);
    if (b) return `Email to ${p.email} bounced on ${auDay(b.at)}. Check the address with them first.`;
  } else {
    if (!p.mobileRaw) return `No mobile for ${first}, so a text can't go.`;
    if (!p.mobile) return `${first}'s mobile "${p.mobileRaw}" isn't a valid Australian mobile, so a text can't go.`;
    if (!p.receivesSms) return `${first} is set to not receive texts on this job. Tick SMS on their line in People, or pick someone else.`;
  }
  const out = await optOutOf(p, channel);
  if (out) return `${first} unsubscribed on ${auDay(out.at)}.`;
  const [c] = await db.select({ dnm: schema.contacts.doNotMarket, why: schema.contacts.doNotMarketReason, active: schema.contacts.active }).from(schema.contacts).where(eq(schema.contacts.id, p.contactId));
  if (c && !c.active) return `${first}'s card is archived.`;
  if (c?.dnm && purpose !== "followup") return `${first} is marked do not market${c.why ? ` (${c.why})` : ""}.`;
  return null;
}

function andOr(xs: string[]) {
  const ys = [...new Set(xs)];
  return ys.length <= 1 ? (ys[0] ?? "someone else") : `${ys.slice(0, -1).join(", ")} or ${ys[ys.length - 1]}`;
}

/** Two or more people who could be the homeowner: the office picks, never Terra Ops. */
export function homeownerAmbiguity(ctx: JobCommsContext): string | null {
  const hs = ctx.people.filter((p) => p.roles.includes("homeowner"));
  return hs.length > 1 ? `${hs.length} people are tagged Owner or Landlord (${hs.map((h) => h.name).join(", ")}). Pick who gets it.` : null;
}

/* ---------------------------------------------------------------------------
 * The approval snapshot
 * ------------------------------------------------------------------------- */

export type Snapshot = {
  people: Array<{ contactId: number; email: string; mobile: string; tags: string[]; onJob: boolean }>;
  companyId: number | null;
  type: CustomerType;
};

/** What exactly was approved: each recipient's details and tags, and the job's company and type. */
export function snapshotOf(ctx: JobCommsContext, contactIds: number[]): string {
  const snap: Snapshot = {
    people: contactIds.map((id) => {
      const p = ctx.people.find((x) => x.contactId === id);
      return { contactId: id, email: p?.email ?? "", mobile: p?.mobile ?? p?.mobileRaw ?? "", tags: [...(p?.tags ?? [])].sort(), onJob: !!p };
    }),
    companyId: ctx.company?.id ?? null,
    type: ctx.type,
  };
  return JSON.stringify(snap);
}

/** Why the approval no longer holds, or null when nothing that matters changed. */
export function snapshotChange(ctx: JobCommsContext, saved: string): string | null {
  let snap: Snapshot;
  try {
    snap = JSON.parse(saved) as Snapshot;
  } catch {
    return "Nothing approved yet.";
  }
  if (!snap || !Array.isArray(snap.people)) return "Nothing approved yet.";
  if ((snap.companyId ?? null) !== (ctx.company?.id ?? null)) return "The job's company changed since this was approved.";
  if (snap.type !== ctx.type) return `The customer type changed to ${CUSTOMER_TYPE_LABELS[ctx.type]} since this was approved.`;
  for (const was of snap.people) {
    const p = ctx.people.find((x) => x.contactId === was.contactId);
    const who = p?.name ?? "The approved person";
    if (!p) return `${who} is no longer on this job.`;
    if (was.email !== p.email) return `${p.name}'s email changed since this was approved.`;
    if (was.mobile !== (p.mobile ?? p.mobileRaw)) return `${p.name}'s mobile changed since this was approved.`;
    if (JSON.stringify(was.tags) !== JSON.stringify([...p.tags].sort())) return `${p.name}'s tags on this job changed since this was approved.`;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * History
 * ------------------------------------------------------------------------- */

export type CommsKind = "quote_followup" | "care" | "care_guide" | "review" | "job" | "people";

export async function commsEvent(e: {
  jobId: number | null;
  kind: CommsKind;
  refId?: number | null;
  event: string;
  detail?: string;
  channel?: string;
  toAddress?: string;
  sendId?: number | null;
  messageId?: number | null;
  byName: string;
}) {
  await db.insert(schema.commsEvents).values({
    jobId: e.jobId,
    kind: e.kind,
    refId: e.refId ?? null,
    event: e.event,
    detail: (e.detail ?? "").slice(0, 600),
    channel: e.channel ?? "",
    toAddress: e.toAddress ?? "",
    sendId: e.sendId ?? null,
    messageId: e.messageId ?? null,
    byName: e.byName,
  });
}

export async function commsHistory(jobId: number) {
  return db.select().from(schema.commsEvents).where(eq(schema.commsEvents.jobId, jobId)).orderBy(desc(schema.commsEvents.id)).limit(200);
}
