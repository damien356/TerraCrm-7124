import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  CARE_FLOOR_LABELS,
  CARE_ON_KEY,
  CARE_STARTED_KEY,
  CARE_WOOL_RANGES_DEFAULT,
  CARE_TRADE_COMPANY_TYPES,
  CARE_WOOL_RANGES_KEY,
  FLOOR_RESTART_DAYS,
  HOLIDAY_SEND_HOUR,
  PASSED_OVER_NOTE,
  RESEND_AFTER_DAYS,
  SLOW_RULES,
  codeKind,
  isCareFloor,
  scheduleKeyFor,
  type CareFloor,
  type ScheduleKey,
} from "./care-codes";
import { detectFibre, detectFloors, strongerFibre, strongerPile, type DetectProduct } from "./care-detect";
import { holidayDue, nextEmail, pastDue, scheduleKeysOf, type PlanHistory, type PlanInput, type PlanItem } from "./care-plan";
import { careBody, renderCareEmail } from "./care-render";
import { CARE_TEMPLATE_MAP } from "./care-templates";
import { openPixelUrl, sendMarketing } from "./marketing";
import { notifyOffice } from "./notify";
import { COMPANY_TYPE_LABELS, parseTags } from "./person-tags";

/* ---------------------------------------------------------------------------
 * The after-job care series engine. Section 18.37.
 *
 * Two jobs, run on one timer (lib/care-boot.ts):
 *
 *   scan   finds jobs completed since the engine was first switched on that it
 *          has not looked at yet (jobs.care_state blank), works out who the
 *          homeowner is and what went down, and puts them in the series.
 *          A carpet with no known fibre waits for Damien's one-tap answer.
 *
 *   tick   for each person in the series, asks the planner (lib/care-plan.ts)
 *          what is next and sends it once it is due. Holiday emails first, then
 *          the series, then the one resend of an email not opened in 7 days.
 *
 * Every email goes through sendMarketing, so consent, unsubscribes, quiet
 * hours, the 24 hour rule and the daily cap all still apply. A send knocked
 * back for timing simply goes again on a later tick.
 *
 * Nothing is planned ahead and stored. The plan is worked out from what has
 * been sent (care_sends) each time, so an email Damien switches off or a
 * second job just changes the next answer.
 * ------------------------------------------------------------------------- */

const DAY = 86_400_000;

/* ---------------------------------------------------------------------------
 * Settings
 * ------------------------------------------------------------------------- */

async function readSetting(key: string): Promise<string | null> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key));
  return row?.value ?? null;
}

async function writeSetting(key: string, value: string) {
  await db
    .insert(schema.settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

export interface CareSettings {
  on: boolean;
  /** Jobs completed before this are not added on their own. Null until first switched on. */
  startedAt: Date | null;
  woolRanges: string[];
}

export function parseWoolRanges(raw: string | null | undefined): string[] {
  if (raw == null) return [...CARE_WOOL_RANGES_DEFAULT];
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());
  } catch {
    /* fall through */
  }
  return [...CARE_WOOL_RANGES_DEFAULT];
}

export async function careSettings(): Promise<CareSettings> {
  const rows = await db
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, [CARE_ON_KEY, CARE_STARTED_KEY, CARE_WOOL_RANGES_KEY]));
  const v = new Map(rows.map((r) => [r.key, r.value]));
  const started = Number(v.get(CARE_STARTED_KEY) ?? "");
  return {
    on: v.get(CARE_ON_KEY) === "1",
    startedAt: Number.isFinite(started) && started > 0 ? new Date(started) : null,
    woolRanges: parseWoolRanges(v.get(CARE_WOOL_RANGES_KEY)),
  };
}

/**
 * Switching it on the first time sets the start, so years of old jobs are not
 * added by surprise. It also passes over every email whose date went by while
 * it was off, so the people already added start from that day.
 */
export async function setCareOn(on: boolean, now = new Date()) {
  await writeSetting(CARE_ON_KEY, on ? "1" : "0");
  if (on && !(await readSetting(CARE_STARTED_KEY))) {
    await writeSetting(CARE_STARTED_KEY, String(now.getTime()));
    await passOverAll(now);
  }
  return careSettings();
}

export async function setWoolRanges(list: string[]) {
  const clean = [...new Set(list.map((s) => s.trim()).filter(Boolean))].slice(0, 200);
  await writeSetting(CARE_WOOL_RANGES_KEY, JSON.stringify(clean));
  return clean;
}

/* ---------------------------------------------------------------------------
 * Templates: the spec's copy, with Damien's edits on top
 * ------------------------------------------------------------------------- */

export interface LiveTemplate {
  code: string;
  title: string;
  audience: string;
  subject: string;
  body: string;
  active: boolean;
  edited: boolean;
}

export async function careTemplates(): Promise<Map<string, LiveTemplate>> {
  const edits = await db.select().from(schema.careTemplates);
  const byCode = new Map(edits.map((e) => [e.code, e]));
  const out = new Map<string, LiveTemplate>();
  for (const [code, t] of CARE_TEMPLATE_MAP) {
    const e = byCode.get(code);
    out.set(code, {
      code,
      title: t.title,
      audience: t.audience,
      subject: e?.subject?.trim() ? e.subject : t.subject,
      body: e?.body?.trim() ? e.body : t.body,
      active: e ? e.active : true,
      edited: !!e && (!!e.subject.trim() || !!e.body.trim()),
    });
  }
  return out;
}

export const inactiveCodes = (t: Map<string, LiveTemplate>) => new Set([...t.values()].filter((x) => !x.active).map((x) => x.code));

/* ---------------------------------------------------------------------------
 * Members
 * ------------------------------------------------------------------------- */

export interface MemberFloor {
  floor: CareFloor;
  jobId: number | null;
  /** ms */
  startedAt: number;
}

export function parseMemberFloors(raw: string | null | undefined): MemberFloor[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((f): f is MemberFloor => !!f && typeof f === "object" && isCareFloor((f as MemberFloor).floor) && typeof (f as MemberFloor).startedAt === "number")
      .map((f) => ({ floor: f.floor, jobId: typeof f.jobId === "number" ? f.jobId : null, startedAt: f.startedAt }));
  } catch {
    return [];
  }
}

/**
 * New floors join with their own start. One series per floor type in any 12
 * months: a floor they already have restarts only when this job is 12 months
 * or more after that floor's start. An earlier job seen late (within the same
 * 12 months) moves the start back. Anything else changes nothing.
 */
export function mergeFloors(had: MemberFloor[], add: MemberFloor[]) {
  const out = new Map(had.map((f) => [f.floor, f]));
  const added: CareFloor[] = [];
  const restarted: CareFloor[] = [];
  const year = FLOOR_RESTART_DAYS * DAY;
  for (const f of add) {
    const was = out.get(f.floor);
    if (!was) {
      out.set(f.floor, f);
      added.push(f.floor);
    } else if (f.startedAt - was.startedAt >= year) {
      out.set(f.floor, f);
      restarted.push(f.floor);
    } else if (f.startedAt < was.startedAt && was.startedAt - f.startedAt < year) out.set(f.floor, f);
  }
  return { floors: [...out.values()], added, restarted };
}

/* ---------------------------------------------------------------------------
 * Who is the homeowner on a job
 * ------------------------------------------------------------------------- */

/** Tags that rule a person out even if they are also tagged Owner. */
const NOT_HOMEOWNER_TAGS = new Set(["builder_contact", "property_manager", "accounts", "supervisor", "tenant"]);
/** Either of these on a job makes it a rental: only the Landlord gets the emails. */
const RENTAL_TAGS = new Set(["tenant", "property_manager"]);

export type HomeownerPick = { contactId: number; landlord: boolean; via: string } | { contactId: null; reason: string };

type JobRow = typeof schema.jobs.$inferSelect;

/** A job for a builder, insurer, agency or other company, not straight for the homeowner. */
export const isCompanyJob = (job: Pick<JobRow, "companyId" | "billToCompanyId" | "billToType">) =>
  !!job.companyId || !!job.billToCompanyId || job.billToType === "company";

/**
 * Who gets the care emails for a job: the person living in the house, never
 * whoever pays.
 *
 *  - A job contact tagged Owner or Landlord comes first, if they hold no
 *    builder, supervisor, property manager or accounts tag and are not one of
 *    the billed company's people. One with an email wins over one without.
 *  - On a company job (builder, insurance, property manager and the rest) that
 *    is the only way in. The job's client, the bill-to contact and every person
 *    on the company's card are never picked. No tagged owner, no emails.
 *  - Rental jobs (Damien, 13 Oct): the Landlord tagged on the job gets them,
 *    never the tenant or the property manager. A Landlord who pays the bill
 *    still counts, unless they are on the company's card. A job with a Tenant or
 *    Property manager tagged and no Landlord or Owner tagged gets nobody.
 *  - On a homeowner job with nobody tagged, the job's client is the homeowner.
 */
export async function homeownerFor(job: JobRow): Promise<HomeownerPick> {
  const people = await db
    .select({ contactId: schema.jobContacts.contactId, tags: schema.jobContacts.tags, isPrimary: schema.jobContacts.isPrimary, email: schema.contacts.email })
    .from(schema.jobContacts)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.jobContacts.contactId))
    .where(eq(schema.jobContacts.jobId, job.id))
    .orderBy(desc(schema.jobContacts.isPrimary), asc(schema.jobContacts.id));

  const companyJob = isCompanyJob(job);
  const companyIds = [...new Set([job.companyId, job.billToCompanyId].filter((x): x is number => !!x))];
  const companyPeople = new Set<number>();
  if (companyIds.length) {
    const links = await db.select({ contactId: schema.companyContacts.contactId }).from(schema.companyContacts).where(inArray(schema.companyContacts.companyId, companyIds));
    for (const l of links) companyPeople.add(l.contactId);
  }
  /* The people paying or running the job for the company. */
  const payer = new Set<number>(companyPeople);
  if (companyJob) {
    if (job.billToContactId) payer.add(job.billToContactId);
    if (job.contactId) payer.add(job.contactId);
  }

  const tagged = people
    .map((p) => ({ ...p, tags: parseTags(p.tags) as string[], hasEmail: !!(p.email ?? "").trim() }))
    .filter(
      (p) =>
        (p.tags.includes("owner") || p.tags.includes("landlord")) &&
        !p.tags.some((t) => NOT_HOMEOWNER_TAGS.has(t)) &&
        !companyPeople.has(p.contactId) &&
        (!payer.has(p.contactId) || p.tags.includes("landlord")),
    );
  if (tagged.length) {
    const pool = tagged.some((x) => x.hasEmail) ? tagged.filter((x) => x.hasEmail) : tagged;
    const p = pool.find((x) => x.tags.includes("landlord")) ?? pool[0]!;
    return { contactId: p.contactId, landlord: p.tags.includes("landlord"), via: p.tags.includes("landlord") ? "Landlord tag" : "Owner tag" };
  }

  if (companyJob) return { contactId: null, reason: "company job (builder, insurance or agency) with no Owner or Landlord tagged on it" };
  if (people.some((p) => parseTags(p.tags).some((t) => RENTAL_TAGS.has(t)))) {
    return { contactId: null, reason: "rental job (tenant or property manager on it) with no Landlord tagged" };
  }
  if (!job.contactId) return { contactId: null, reason: "no client on the job" };

  /* The job's client, unless they hold a non-homeowner tag on this job. */
  const self = people.find((p) => p.contactId === job.contactId);
  if (self && parseTags(self.tags).some((t) => NOT_HOMEOWNER_TAGS.has(t))) {
    return { contactId: null, reason: "the job's client is tagged builder, supervisor, property manager, accounts or tenant" };
  }
  return { contactId: job.contactId, landlord: false, via: "job client" };
}

/**
 * Is this person trade, for the care series? Decided by type only, never by
 * how many jobs they have had or their email address, so a repeat homeowner
 * still gets the emails.
 *
 *  - Marked Trade on their card: trade. Marked Homeowner: never trade.
 *  - Otherwise, on the card of a builder, insurance builder, property manager,
 *    real estate agency or commercial company: trade.
 */
export async function careTradeReason(contactId: number): Promise<string | null> {
  const [c] = await db.select({ kind: schema.contacts.audienceKind }).from(schema.contacts).where(eq(schema.contacts.id, contactId));
  if (c?.kind === "trade") return "is marked trade";
  if (c?.kind === "homeowner") return null;
  const [co] = await db
    .select({ name: schema.companies.name, type: schema.companies.type })
    .from(schema.companyContacts)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.companyContacts.companyId))
    .where(and(eq(schema.companyContacts.contactId, contactId), inArray(schema.companies.type, [...CARE_TRADE_COMPANY_TYPES])))
    .limit(1);
  if (co) return `works for ${co.name} (${(COMPANY_TYPE_LABELS[co.type ?? ""] ?? co.type ?? "").toLowerCase()})`;
  return null;
}

/* ---------------------------------------------------------------------------
 * What went down on a job
 * ------------------------------------------------------------------------- */

export interface JobCareFacts {
  floors: CareFloor[];
  floorsFrom: string;
  fibre: string;
  pile: string;
  fibreFrom: string;
  hasCarpet: boolean;
}

const productCols = {
  category: schema.products.category,
  soldAs: schema.products.soldAs,
  fibre: schema.products.fibre,
  pile: schema.products.pile,
  tier: schema.products.tier,
  brand: schema.products.brand,
  range: schema.products.range,
  colour: schema.products.colour,
  notes: schema.products.notes,
};

export async function jobCareFacts(job: JobRow, woolRanges: string[]): Promise<JobCareFacts> {
  const [quote] = await db
    .select({ id: schema.quotes.id })
    .from(schema.quotes)
    .where(and(eq(schema.quotes.jobId, job.id), eq(schema.quotes.status, "accepted")))
    .orderBy(desc(schema.quotes.version), desc(schema.quotes.id))
    .limit(1);

  const products: DetectProduct[] = [];
  const lineTexts: string[] = [];
  if (quote) {
    const items = await db
      .select({ description: schema.quoteItems.description, p: productCols })
      .from(schema.quoteItems)
      .leftJoin(schema.products, eq(schema.products.id, schema.quoteItems.productId))
      .where(eq(schema.quoteItems.quoteId, quote.id));
    for (const i of items) {
      lineTexts.push(i.description);
      if (i.p?.category) products.push(i.p as DetectProduct);
    }
  }
  const mats = await db
    .select({ description: schema.jobMaterials.description, p: productCols })
    .from(schema.jobMaterials)
    .leftJoin(schema.products, eq(schema.products.id, schema.jobMaterials.productId))
    .where(eq(schema.jobMaterials.jobId, job.id));
  for (const m of mats) {
    lineTexts.push(m.description);
    if (m.p?.category) products.push(m.p as DetectProduct);
  }

  const fl = detectFloors({ careFloors: job.careFloors, category: job.category, title: job.title, description: job.description, products, lineTexts });
  const hasCarpet = fl.floors.includes("carpet");
  const fib = hasCarpet
    ? detectFibre({ fibre: job.fibre, pile: job.pile, title: job.title, description: job.description, category: job.category, products, lineTexts }, woolRanges)
    : { fibre: "", pile: "", from: "" };
  return { floors: fl.floors, floorsFrom: fl.from, fibre: fib.fibre, pile: fib.pile, fibreFrom: fib.from, hasCarpet };
}

/* ---------------------------------------------------------------------------
 * Adding a completed job
 * ------------------------------------------------------------------------- */

export type EnrolOutcome = { state: "added" | "waiting_wool" | "skipped"; note: string; memberId?: number; contactId?: number };

async function markJob(jobId: number, state: EnrolOutcome["state"], note: string) {
  await db.update(schema.jobs).set({ careState: state, careNote: note.slice(0, 500), updatedAt: new Date() }).where(eq(schema.jobs.id, jobId));
}

const floorList = (f: CareFloor[]) => f.map((x) => CARE_FLOOR_LABELS[x]).join(", ");

/**
 * Looks at one completed job and adds its homeowner to the series, or says why
 * not. Writes jobs.care_state and care_note either way, so the job is not
 * looked at again unless the office clears it (Care page, "Try again").
 */
export async function enrolJob(jobId: number, opts: { now?: Date; notify?: boolean; woolRanges?: string[] } = {}): Promise<EnrolOutcome> {
  const now = opts.now ?? new Date();
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) return { state: "skipped", note: "job not found" };

  const done = async (o: EnrolOutcome) => {
    await markJob(jobId, o.state, o.note);
    return o;
  };

  if (job.parentJobId) return done({ state: "skipped", note: "callback job, the original job already counts" });

  // Fix 2 (Damien, 30 Oct): the care emails talk about the install. A supply
  // only sale had none, so it is skipped. A care guide can still be sent by
  // hand from the job (Send a care guide).
  const { supplyOnlyOf } = await import("./delivery");
  if ((await supplyOnlyOf(jobId)).supplyOnly) return done({ state: "skipped", note: "Supply only, no install. Send a care guide from the job if they want one" });

  const pick = await homeownerFor(job);
  if (pick.contactId === null) return done({ state: "skipped", note: pick.reason });

  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, pick.contactId));
  if (!contact) return done({ state: "skipped", note: "contact not found" });
  const name = `${contact.firstName} ${contact.lastName}`.trim();
  if (contact.doNotMarket) return done({ state: "skipped", note: `${name} is marked do not market`, contactId: contact.id });
  if (!(contact.email ?? "").trim()) return done({ state: "skipped", note: `${name} has no email`, contactId: contact.id });

  const trade = await careTradeReason(contact.id);
  if (trade) return done({ state: "skipped", note: `${name} ${trade}`, contactId: contact.id });

  const [unsub] = await db
    .select({ id: schema.unsubscribes.id })
    .from(schema.unsubscribes)
    .where(
      and(
        inArray(schema.unsubscribes.channel, ["email", "all"]),
        sql`(${schema.unsubscribes.contactId} = ${contact.id} or ${schema.unsubscribes.email} = ${(contact.email ?? "").trim().toLowerCase()})`,
      ),
    )
    .limit(1);
  if (unsub) return done({ state: "skipped", note: `${name} unsubscribed`, contactId: contact.id });

  const woolRanges = opts.woolRanges ?? (await careSettings()).woolRanges;
  const facts = await jobCareFacts(job, woolRanges);
  if (!facts.floors.length) {
    return done({ state: "skipped", note: "could not tell what floor went down. Set the floors on the job, then Try again", contactId: contact.id });
  }

  if (facts.hasCarpet && facts.fibre === "unknown") {
    await markJob(jobId, "waiting_wool", "Is this carpet wool? The care emails wait for the answer.");
    if (opts.notify !== false) {
      await notifyOffice("care_wool", {
        title: `Is this carpet wool? Job ${job.displayNumber ?? job.number}`,
        body: `${name}: ${job.title || "carpet job"}. Answer Yes, Wool blend or No on the job and the care emails start.`,
        jobId: job.id,
      });
    }
    return { state: "waiting_wool", note: "waiting for the wool answer", contactId: contact.id };
  }

  const landlord = job.careLandlord ?? pick.landlord;
  const startedAt = (job.completedAt ?? now).getTime();
  const add: MemberFloor[] = facts.floors.map((floor) => ({ floor, jobId: job.id, startedAt }));
  const fibre = facts.hasCarpet ? facts.fibre : "";
  const pile = facts.hasCarpet ? facts.pile : "";

  /* Inferred consent: Terra installed their floor. Express opt-in stays as it is. */
  if (!contact.marketingOptIn && contact.marketingBasis === "none") {
    await db.update(schema.contacts).set({ marketingBasis: "completed_job", updatedAt: now }).where(eq(schema.contacts.id, contact.id));
  }

  /*
   * A job done before the series was switched on (the last 6 months added at
   * the start) starts from today: emails whose date has gone are passed over.
   */
  const settingsNow = await careSettings();
  const lateJoin = !settingsNow.startedAt || startedAt < settingsNow.startedAt.getTime();

  const [had] = await db.select().from(schema.careMembers).where(eq(schema.careMembers.contactId, contact.id));
  if (had) {
    if (had.status !== "active") {
      return done({ state: "skipped", note: `${name} ${had.status === "unsubscribed" ? "unsubscribed" : "was taken out of the series"}, not restarted`, memberId: had.id, contactId: contact.id });
    }
    const merged = mergeFloors(parseMemberFloors(had.floors), add);
    await db
      .update(schema.careMembers)
      .set({
        floors: JSON.stringify(merged.floors),
        fibre: strongerFibre(had.fibre, fibre),
        pile: strongerPile(had.pile, pile),
        landlord: had.landlord || landlord,
        lastJobId: job.id,
        updatedAt: now,
      })
      .where(eq(schema.careMembers.id, had.id));
    if (lateJoin) await passOverMember(had.id, now);
    const bits = [
      merged.added.length ? `added ${floorList(merged.added)}` : "",
      merged.restarted.length ? `restarted ${floorList(merged.restarted)} (last one over 12 months ago)` : "",
    ].filter(Boolean);
    return done({
      state: "added",
      note: bits.length ? `${name} already in the series, ${bits.join(", ")}` : `${name} already in the series with these floors in the last 12 months`,
      memberId: had.id,
      contactId: contact.id,
    });
  }

  const [row] = await db
    .insert(schema.careMembers)
    .values({
      contactId: contact.id,
      status: "active",
      floors: JSON.stringify(add),
      fibre,
      pile,
      landlord,
      startedAt: new Date(startedAt),
      lastJobId: job.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.careMembers.id });
  if (lateJoin) await passOverMember(row!.id, now);
  return done({ state: "added", note: `${name} added (${floorList(facts.floors)}, via ${pick.via})`, memberId: row!.id, contactId: contact.id });
}

/**
 * Writes every series email whose date has gone as passed over, so the member
 * starts from now. Safe to run again: passed over counts as handled.
 */
export async function passOverMember(memberId: number, now = new Date()) {
  const [m] = await db.select().from(schema.careMembers).where(eq(schema.careMembers.id, memberId));
  if (!m || m.status !== "active") return 0;
  const rows = await db.select().from(schema.careSends).where(eq(schema.careSends.memberId, m.id));
  const past = pastDue(planInputFor(m, rows, now, new Set()));
  if (!past.length) return 0;
  await db.insert(schema.careSends).values(
    past.map((p) => ({
      memberId: m.id,
      contactId: m.contactId,
      jobId: p.jobId ?? m.lastJobId ?? null,
      code: p.code,
      kind: p.kind,
      dueAt: p.dueAt,
      status: "skipped" as const,
      note: PASSED_OVER_NOTE,
      createdAt: now,
      updatedAt: now,
    })),
  );
  return past.length;
}

/** The first switch on: everyone already in the series starts from that day. */
export async function passOverAll(now = new Date()) {
  const members = await db.select({ id: schema.careMembers.id }).from(schema.careMembers).where(eq(schema.careMembers.status, "active"));
  let n = 0;
  for (const m of members) n += await passOverMember(m.id, now);
  return n;
}

/** Statuses that count as Completed for the trigger: stage complete (Complete, Invoiced) and Paid. */
async function completedStatusIds() {
  const rows = await db.select({ id: schema.jobStatuses.id, name: schema.jobStatuses.name, stage: schema.jobStatuses.stage }).from(schema.jobStatuses);
  return rows.filter((r) => r.stage === "complete" || (r.stage === "closed" && r.name.trim().toLowerCase() === "paid")).map((r) => r.id);
}

/** Completed jobs since the engine first went on, not looked at yet. */
export async function scanCompleted(now = new Date(), limit = 50) {
  const s = await careSettings();
  const out = { looked: 0, added: 0, waiting: 0, skipped: 0 };
  if (!s.startedAt) return out;
  const ids = await completedStatusIds();
  if (!ids.length) return out;
  const since = Math.floor(s.startedAt.getTime() / 1000);
  const jobs = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.careState, ""),
        inArray(schema.jobs.statusId, ids),
        sql`coalesce(${schema.jobs.completedAt}, ${schema.jobs.updatedAt}) >= ${since}`,
      ),
    )
    .orderBy(asc(schema.jobs.id))
    .limit(limit);
  for (const j of jobs) {
    const r = await enrolJob(j.id, { now, woolRanges: s.woolRanges });
    out.looked++;
    if (r.state === "added") out.added++;
    else if (r.state === "waiting_wool") out.waiting++;
    else out.skipped++;
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Sending
 * ------------------------------------------------------------------------- */

type MemberRow = typeof schema.careMembers.$inferSelect;
type SendRow = typeof schema.careSends.$inferSelect;

export function historyOf(rows: SendRow[]): PlanHistory[] {
  return rows
    .filter((r) => r.status === "sent" || r.status === "skipped" || r.status === "failed")
    .map((r) => ({ code: r.code, at: r.sentAt ?? r.dueAt ?? r.createdAt, status: r.status as PlanHistory["status"] }));
}

export function planInputFor(m: MemberRow, rows: SendRow[], now: Date, inactive: Set<string>, slow = false): PlanInput {
  return {
    memberId: m.id,
    floors: parseMemberFloors(m.floors).map((f) => ({ floor: f.floor, jobId: f.jobId, startedAt: new Date(f.startedAt) })),
    fibre: m.fibre,
    pile: m.pile,
    landlord: m.landlord,
    history: historyOf(rows),
    inactive,
    slow,
    now,
  };
}

/**
 * The slow rule: a schedule group whose care emails lose more than about 1% to
 * unsubscribes, or get opened less than about 30% of the time, goes to every
 * 12 weeks in year 2. Measured over the last 90 days, once there are 30 sends.
 */
export async function slowGroups(now = new Date()): Promise<Set<ScheduleKey>> {
  const since = new Date(now.getTime() - 90 * DAY);
  const rows = await db
    .select({ floors: schema.careMembers.floors, landlord: schema.careMembers.landlord, status: schema.careMembers.status, opened: schema.careSends.openedAt, sentAt: schema.careSends.sentAt, updatedAt: schema.careMembers.updatedAt })
    .from(schema.careSends)
    .innerJoin(schema.careMembers, eq(schema.careMembers.id, schema.careSends.memberId))
    .where(and(eq(schema.careSends.status, "sent"), isNotNull(schema.careSends.sentAt), sql`${schema.careSends.sentAt} >= ${Math.floor(since.getTime() / 1000)}`));
  const stats = new Map<ScheduleKey, { sends: number; opens: number }>();
  for (const r of rows) {
    for (const k of new Set(parseMemberFloors(r.floors).map((f) => scheduleKeyFor(f.floor, r.landlord)))) {
      const s = stats.get(k) ?? { sends: 0, opens: 0 };
      s.sends++;
      if (r.opened) s.opens++;
      stats.set(k, s);
    }
  }
  const unsubs = await db
    .select({ floors: schema.careMembers.floors, landlord: schema.careMembers.landlord })
    .from(schema.careMembers)
    .where(and(eq(schema.careMembers.status, "unsubscribed"), sql`${schema.careMembers.updatedAt} >= ${Math.floor(since.getTime() / 1000)}`));
  const lost = new Map<ScheduleKey, number>();
  for (const u of unsubs) for (const k of new Set(parseMemberFloors(u.floors).map((f) => scheduleKeyFor(f.floor, u.landlord)))) lost.set(k, (lost.get(k) ?? 0) + 1);

  const out = new Set<ScheduleKey>();
  for (const [k, s] of stats) {
    if (s.sends < SLOW_RULES.minSends) continue;
    if ((lost.get(k) ?? 0) / s.sends > SLOW_RULES.unsubAbove || s.opens / s.sends < SLOW_RULES.opensBelow) out.add(k);
  }
  return out;
}

const cleanFirst = (s: string | null | undefined) => {
  const f = (s ?? "").trim().split(/\s+/)[0] ?? "";
  if (!f || /^(mr|mrs|ms|miss|dr)\.?$/i.test(f) || /[@\d]/.test(f)) return "there";
  return f.charAt(0).toUpperCase() + f.slice(1);
};

export type CareSendOutcome =
  | { ok: true; careSendId: number; sendId: number }
  | { ok: false; deferred: boolean; reason: string; careSendId?: number };

/**
 * Sends one care email to one member and records it. Used by the tick, by the
 * resend and by the Care page's "Send me a test" (test: true goes to the given
 * address only and records nothing in care_sends).
 */
export async function sendCareEmail(args: {
  member: MemberRow;
  contact: typeof schema.contacts.$inferSelect;
  item: Pick<PlanItem, "code" | "kind" | "dueAt" | "jobId">;
  templates: Map<string, LiveTemplate>;
  resendOf?: SendRow;
  test?: { to: string };
}): Promise<CareSendOutcome> {
  const { member, contact, item, templates } = args;
  const t = templates.get(item.code);
  if (!t) return { ok: false, deferred: false, reason: `no template for ${item.code}` };
  const body = careBody(t.body, { fibre: member.fibre, pile: member.pile }, !!args.resendOf);
  const sendContact = args.test ? { ...contact, id: -1, email: args.test.to } : contact;

  const r = await sendMarketing({
    contact: sendContact,
    channel: "email",
    subject: t.subject,
    body,
    sender: "care",
    startHour: item.kind === "holiday" ? HOLIDAY_SEND_HOUR : undefined,
    merge: { contact: { ...contact, firstName: cleanFirst(contact.firstName) } },
    test: !!args.test,
    render: ({ bodyText, unsubUrl, sendId }) => renderCareEmail(bodyText, { unsubUrl, pixelUrl: sendId > 0 ? openPixelUrl(sendId) : undefined }),
  });
  if (args.test) return r.ok ? { ok: true, careSendId: 0, sendId: r.sendId } : { ok: false, deferred: r.deferred, reason: r.reason };

  const now = new Date();
  if (args.resendOf) {
    if (r.ok || !r.deferred) {
      await db
        .update(schema.careSends)
        .set(r.ok ? { resendSendId: r.sendId, resentAt: now, updatedAt: now } : { resentAt: now, note: `resend failed: ${r.reason}`.slice(0, 300), updatedAt: now })
        .where(eq(schema.careSends.id, args.resendOf.id));
    }
    return r.ok ? { ok: true, careSendId: args.resendOf.id, sendId: r.sendId } : { ok: false, deferred: r.deferred, reason: r.reason, careSendId: args.resendOf.id };
  }

  if (!r.ok && r.deferred) return { ok: false, deferred: true, reason: r.reason };
  const [row] = await db
    .insert(schema.careSends)
    .values({
      memberId: member.id,
      contactId: contact.id,
      jobId: item.jobId ?? member.lastJobId ?? null,
      code: item.code,
      kind: item.kind,
      dueAt: item.dueAt,
      status: r.ok ? "sent" : "failed",
      sendId: r.sendId ?? null,
      sentAt: r.ok ? now : null,
      note: r.ok ? "" : r.reason.slice(0, 300),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.careSends.id });
  return r.ok ? { ok: true, careSendId: row!.id, sendId: r.sendId } : { ok: false, deferred: false, reason: r.reason, careSendId: row!.id };
}

/** Consent reasons that mean stop for good, not try later. */
const STOP_REASONS = /unsubscribed|no consent|no email|do not market/i;

/** A time-critical email (S1, the day after sanding) this late is no use. It is passed over. */
const URGENT_LATE_DAYS = 3;

/** What one tick did, for the log and the tests. */
export interface TickResult {
  members: number;
  sent: number;
  resent: number;
  deferred: number;
  failed: number;
  skipped: number;
  stopped: number;
}

/** Most care emails one tick sends, so a holiday morning goes out over a few ticks. */
const PER_TICK = 25;

export async function careTick(now = new Date(), opts: { pauseMs?: number } = {}): Promise<TickResult> {
  const out: TickResult = { members: 0, sent: 0, resent: 0, deferred: 0, failed: 0, skipped: 0, stopped: 0 };
  const members = await db.select().from(schema.careMembers).where(eq(schema.careMembers.status, "active")).orderBy(asc(schema.careMembers.id));
  out.members = members.length;
  if (!members.length) return out;

  const templates = await careTemplates();
  const inactive = inactiveCodes(templates);
  const slow = await slowGroups(now);
  const allSends = await db.select().from(schema.careSends).where(inArray(schema.careSends.memberId, members.map((m) => m.id)));
  const byMember = new Map<number, SendRow[]>();
  for (const s of allSends) byMember.set(s.memberId, [...(byMember.get(s.memberId) ?? []), s]);
  const contacts = await db.select().from(schema.contacts).where(inArray(schema.contacts.id, members.map((m) => m.contactId)));
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  let budget = PER_TICK;
  for (const m of members) {
    if (budget <= 0) break;
    const contact = contactById.get(m.contactId);
    if (!contact) continue;
    const rows = byMember.get(m.id) ?? [];
    const input = planInputFor(m, rows, now, inactive, scheduleKeysOf(planInputFor(m, rows, now, inactive)).some((k) => slow.has(k)));

    const due: PlanItem | null = holidayDue(input) ?? (() => {
      const n = nextEmail(input);
      return n && n.dueAt.getTime() <= now.getTime() ? n : null;
    })();

    if (due) {
      /* Too late to be useful: passed over and noted, so the plan moves on. */
      const urgentLate = due.code === "S1" && now.getTime() - due.dueAt.getTime() > URGENT_LATE_DAYS * DAY;
      if (urgentLate) {
        await db.insert(schema.careSends).values({ memberId: m.id, contactId: m.contactId, jobId: due.jobId ?? null, code: due.code, kind: due.kind, dueAt: due.dueAt, status: "skipped", note: "too late to be useful, passed over", createdAt: now, updatedAt: now });
        out.skipped++;
        continue;
      }
      const r = await sendCareEmail({ member: m, contact, item: due, templates });
      budget--;
      if (r.ok) out.sent++;
      else if (r.deferred) out.deferred++;
      else {
        out.failed++;
        if (STOP_REASONS.test(r.reason)) {
          await db.update(schema.careMembers).set({ status: /unsubscribed/i.test(r.reason) ? "unsubscribed" : "stopped", stopReason: r.reason.slice(0, 200), updatedAt: now }).where(eq(schema.careMembers.id, m.id));
          out.stopped++;
        }
      }
      if (opts.pauseMs) await new Promise((res) => setTimeout(res, opts.pauseMs));
      continue;
    }

    /* The one resend: not opened 7 days after it went, never a holiday, never twice, and not once it is 14 days old. */
    const resend = rows.find(
      (r) =>
        r.status === "sent" &&
        r.sentAt &&
        !r.openedAt &&
        !r.resentAt &&
        codeKind(r.code) !== "holiday" &&
        now.getTime() - r.sentAt.getTime() >= RESEND_AFTER_DAYS * DAY &&
        now.getTime() - r.sentAt.getTime() < 2 * RESEND_AFTER_DAYS * DAY,
    );
    if (resend) {
      const r = await sendCareEmail({ member: m, contact, item: { code: resend.code, kind: resend.kind as PlanItem["kind"], dueAt: resend.dueAt ?? now, jobId: resend.jobId }, templates, resendOf: resend });
      budget--;
      if (r.ok) out.resent++;
      else if (r.deferred) out.deferred++;
      else out.failed++;
      if (opts.pauseMs) await new Promise((res) => setTimeout(res, opts.pauseMs));
    }
  }
  return out;
}
