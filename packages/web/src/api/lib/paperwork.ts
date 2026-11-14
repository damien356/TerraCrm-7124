import { ORPCError } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { commsEvent, isCompanyType, jobComms, type CustomerType, type JobCommsContext, type JobPerson } from "./comms-people";
import { normaliseMobile } from "./sms";

/* ---------------------------------------------------------------------------
 * WHO GETS WHAT on a job (Damien, 14 Nov 2026, after quote 188101).
 *
 * Quotes, variations and invoices carry prices. Each person on the job, and
 * the company, is ticked for each one. Every send is checked here on the
 * server, To, CC and text, right before it goes:
 *
 *   - Only people on the job (or the job's own customer and bill-to person,
 *     and the company) can ever get paperwork. A typed-in address that is not
 *     on the job is refused. Add them to the job and tick them first.
 *   - No tick set means the default from their role:
 *       company or builder job: owner and tenant off, a property manager off
 *       unless the company is a property manager or real estate agency,
 *       supervisor, accounts and billing on;
 *       private job: owner and customer on, tenant off.
 *   - Material selection is not paperwork and is not checked here, but its
 *     page only shows price differences to someone ticked for Quotes.
 *   - A restricted job file (quote, invoice, signed copy, supplier cost) can
 *     only be emailed to someone ticked for at least one kind of paperwork.
 * ------------------------------------------------------------------------- */

export const DOCS = ["quote", "variation", "invoice"] as const;
export type Doc = (typeof DOCS)[number];
export const DOC_PLURAL: Record<Doc, string> = { quote: "quotes", variation: "variations", invoice: "invoices" };
export const DOC_TICK: Record<Doc, string> = { quote: "Quotes", variation: "Variations", invoice: "Invoices" };
const COL = { quote: "getsQuotes", variation: "getsVariations", invoice: "getsInvoices" } as const;

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const low = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export type Tick = { on: boolean; set: boolean; defaultOn: boolean };
export type PaperRow = {
  key: string;
  kind: "person" | "company";
  contactId: number | null;
  companyId: number | null;
  name: string;
  roleLabel: string;
  /** The addresses this row covers, lower case. A company covers its accounts, admin and compliance inboxes. */
  emails: string[];
  mobiles: string[];
  email: string;
  mobileShown: string;
  onJob: boolean;
  quote: Tick;
  variation: Tick;
  invoice: Tick;
  /** Why the default is what it is, in plain words. */
  defaultWhy: string;
};

type Link = typeof schema.jobContacts.$inferSelect;

/** What a person gets when nobody has ticked anything, and why. Pure, so it is tested on its own. */
export function paperworkDefault(
  p: Pick<JobPerson, "roles" | "isClient" | "onJob">,
  type: CustomerType,
  link: Pick<Link, "receivesEmail" | "canApproveQuote"> | null,
): { on: boolean; why: string } {
  const company = isCompanyType(type);
  const r = new Set(p.roles);
  if (r.has("supervisor")) return { on: true, why: "Supervisor or builder contact: gets paperwork." };
  if (r.has("billing")) return { on: true, why: "Billing or accounts: gets paperwork." };
  if (r.has("property_manager")) {
    if (!company || type === "property_manager" || type === "real_estate") return { on: true, why: "Property manager for the client: gets paperwork." };
    return { on: false, why: "Property manager on a builder job: no paperwork unless ticked." };
  }
  if (r.has("homeowner")) {
    if (company) return { on: false, why: "Owner on a company job: never gets paperwork unless ticked." };
    return { on: true, why: "Owner on a private job: gets paperwork." };
  }
  if (r.has("customer")) return { on: true, why: "The customer: gets paperwork." };
  if (r.has("tenant")) return { on: false, why: "Tenant or site contact: never gets paperwork unless ticked." };
  /* Other. As before: the job's own client, or someone ticked for email or as a decision maker. */
  if (p.isClient) return { on: true, why: "The job's customer: gets paperwork." };
  if (link && (link.receivesEmail || link.canApproveQuote)) return { on: true, why: "Ticked for email on the job: gets paperwork." };
  return { on: false, why: "Not ticked for email on the job: no paperwork unless ticked." };
}

/** Everyone who could get paperwork on this job, with their three ticks. Null when the job is gone. */
export async function paperworkFor(jobId: number, ctxIn?: JobCommsContext | null) {
  const ctx = ctxIn ?? (await jobComms(jobId));
  if (!ctx) return null;
  const job = ctx.job;
  const saved = await db.select().from(schema.jobPaperwork).where(eq(schema.jobPaperwork.jobId, jobId));
  const links = await db.select().from(schema.jobContacts).where(eq(schema.jobContacts.jobId, jobId));
  const ids = ctx.people.map((p) => p.contactId);
  const cards = ids.length ? await db.select({ id: schema.contacts.id, phone: schema.contacts.phone, mobile: schema.contacts.mobile }).from(schema.contacts).where(inArray(schema.contacts.id, ids)) : [];

  const tick = (s: typeof schema.jobPaperwork.$inferSelect | undefined, doc: Doc, def: boolean): Tick => {
    const v = s ? s[COL[doc]] : null;
    return v === null || v === undefined ? { on: def, set: false, defaultOn: def } : { on: !!v, set: true, defaultOn: def };
  };

  const rows: PaperRow[] = [];
  for (const p of ctx.people) {
    const link = links.find((l) => l.contactId === p.contactId) ?? null;
    const def = paperworkDefault(p, ctx.type, link);
    const s = saved.find((x) => x.contactId === p.contactId);
    const card = cards.find((c) => c.id === p.contactId);
    const mobiles = [normaliseMobile(card?.mobile), normaliseMobile(card?.phone)].filter((m): m is string => !!m);
    rows.push({
      key: `p:${p.contactId}`,
      kind: "person",
      contactId: p.contactId,
      companyId: null,
      name: p.name,
      roleLabel: p.roleLabel,
      emails: p.email ? [p.email] : [],
      mobiles: [...new Set(mobiles)],
      email: p.email,
      mobileShown: p.mobileRaw,
      onJob: p.onJob,
      quote: tick(s, "quote", def.on),
      variation: tick(s, "variation", def.on),
      invoice: tick(s, "invoice", def.on),
      defaultWhy: def.why,
    });
  }

  const companyIds = [...new Set([job.companyId, job.billToType === "company" ? job.billToCompanyId : null].filter((x): x is number => !!x))];
  const cos = companyIds.length ? await db.select().from(schema.companies).where(inArray(schema.companies.id, companyIds)) : [];
  for (const co of cos) {
    const s = saved.find((x) => x.companyId === co.id);
    const emails = [...new Set([low(co.email), low(co.adminEmail), low(co.complianceEmail)].filter(Boolean))];
    const billed = job.billToType === "company" && (job.billToCompanyId ?? job.companyId) === co.id;
    rows.push({
      key: `c:${co.id}`,
      kind: "company",
      contactId: null,
      companyId: co.id,
      name: co.name,
      roleLabel: billed ? "Company, billed" : "Company",
      emails,
      mobiles: [],
      email: low(co.email),
      mobileShown: "",
      onJob: true,
      quote: tick(s, "quote", true),
      variation: tick(s, "variation", true),
      invoice: tick(s, "invoice", true),
      defaultWhy: "The company: gets paperwork.",
    });
  }
  return { ctx, rows, typeLabel: ctx.typeLabel };
}

const fix = (doc: Doc) => `Tick ${DOC_TICK[doc]} for them under Who gets what on the job, or send to someone else.`;

/** Why these addresses and mobiles can not get this paperwork on this job, or null when they all can. */
export async function paperworkProblem(args: { jobId: number; doc: Doc; emails?: string[]; mobiles?: string[] }): Promise<string | null> {
  const pw = await paperworkFor(args.jobId);
  if (!pw) return "The job is gone.";
  return problemIn(pw.rows, args.doc, args.emails ?? [], args.mobiles ?? []);
}

/** The check itself on rows already read. Pure. */
export function problemIn(rows: PaperRow[], doc: Doc, emails: string[], mobiles: string[]): string | null {
  const label = DOC_PLURAL[doc];
  for (const raw of emails) {
    const e = low(raw);
    if (!e) continue;
    const hits = rows.filter((r) => r.emails.includes(e));
    if (hits.some((r) => r[doc].on)) continue;
    if (hits.length) return `${hits[0]!.name} (${hits[0]!.roleLabel}) is set to never get ${label} on this job, so nothing went to ${e}. ${fix(doc)}`;
    return `${e} is not on this job, so nothing went. Only people on the job ticked for ${DOC_TICK[doc]} can get ${label}. Add them to the job's People, tick ${DOC_TICK[doc]} under Who gets what, then send.`;
  }
  for (const raw of mobiles) {
    const m = normaliseMobile(raw);
    if (!m) continue;
    const hits = rows.filter((r) => r.mobiles.includes(m));
    if (hits.some((r) => r[doc].on)) continue;
    if (hits.length) return `${hits[0]!.name} (${hits[0]!.roleLabel}) is set to never get ${label} on this job, so no text went. ${fix(doc)}`;
    return `That mobile is not anyone on this job, so no text went. Only people on the job ticked for ${DOC_TICK[doc]} can get ${label}. Add them to the job's People and tick ${DOC_TICK[doc]} first.`;
  }
  return null;
}

/** Throws the reason as a plain message. Used right before every quote, variation and invoice send. */
export async function assertPaperwork(args: { jobId: number; doc: Doc; emails?: string[]; mobiles?: string[] }) {
  const p = await paperworkProblem(args);
  if (p) throw bad(p);
}

/** The people and company who may get this paperwork, for the send dialogs. */
export async function allowedFor(jobId: number, doc: Doc) {
  const pw = await paperworkFor(jobId);
  return pw ? pw.rows.filter((r) => r[doc].on) : [];
}

/** True when this person is ticked for quotes on the job: the only people who see prices on the material selection page. */
export async function seesQuotePrices(jobId: number, contactId: number | null | undefined) {
  if (!contactId) return false;
  const pw = await paperworkFor(jobId);
  return !!pw?.rows.find((r) => r.contactId === contactId)?.quote.on;
}

/** Why a restricted (cost) file can not go to these addresses, or null. Anyone ticked for any paperwork may get one. */
export async function costFileProblem(jobId: number, emails: string[]): Promise<string | null> {
  const pw = await paperworkFor(jobId);
  if (!pw) return null;
  for (const raw of emails) {
    const e = low(raw);
    if (!e) continue;
    const hits = pw.rows.filter((r) => r.emails.includes(e));
    if (hits.some((r) => r.quote.on || r.variation.on || r.invoice.on)) continue;
    const who = hits[0] ? `${hits[0].name} (${hits[0].roleLabel})` : e;
    return `One of the files has prices or costs in it, and ${who} is not ticked for any paperwork on this job. Take the file off, or tick them under Who gets what. Nothing went.`;
  }
  return null;
}

/** Tick or untick one box. Null puts it back to the default. Logged on the job's comms history. */
export async function setPaperwork(args: { jobId: number; contactId?: number | null; companyId?: number | null; doc: Doc; on: boolean | null; byName: string }) {
  const pw = await paperworkFor(args.jobId);
  if (!pw) throw bad("Job not found.");
  const key = args.contactId ? `p:${args.contactId}` : args.companyId ? `c:${args.companyId}` : "";
  const row = pw.rows.find((r) => r.key === key);
  if (!row) throw bad(args.contactId ? "That person is not on this job. Add them to People first." : "That company is not on this job.");
  const where = args.contactId
    ? and(eq(schema.jobPaperwork.jobId, args.jobId), eq(schema.jobPaperwork.contactId, args.contactId))
    : and(eq(schema.jobPaperwork.jobId, args.jobId), eq(schema.jobPaperwork.companyId, args.companyId!));
  const [have] = await db.select().from(schema.jobPaperwork).where(where);
  const set = { [COL[args.doc]]: args.on, setByName: args.byName, updatedAt: new Date() };
  if (have) await db.update(schema.jobPaperwork).set(set).where(eq(schema.jobPaperwork.id, have.id));
  else
    await db.insert(schema.jobPaperwork).values({
      jobId: args.jobId,
      contactId: args.contactId ?? null,
      companyId: args.contactId ? null : (args.companyId ?? null),
      ...set,
    });
  const now = args.on === null ? row[args.doc].defaultOn : args.on;
  await commsEvent({
    jobId: args.jobId,
    kind: "people",
    event: "paperwork_changed",
    detail: `${row.name} ${now ? "gets" : "never gets"} ${DOC_PLURAL[args.doc]}${args.on === null ? " (back to the default)" : ""}.`,
    byName: args.byName,
  });
  return paperworkFor(args.jobId);
}
