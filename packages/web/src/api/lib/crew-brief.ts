import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { workDaysFor, type WorkDay } from "./crew-days";
import { crewPeopleFor } from "./crew-people";
import { addLocalDays, localTimeOn, sayDay, sayTime, todayLocal } from "./local-date";

/* ---------------------------------------------------------------------------
 * What Siri knows about a job, put together for the ear rather than the eye.
 *
 * Same fence as the crew app: an installer hears the address, the access
 * notes, the scope, the materials and the site contact's first name. Never a
 * price, a margin, a quote or anyone else's work. Nothing in here reads money.
 * ------------------------------------------------------------------------- */

const STREET_WORDS: Record<string, string> = {
  st: "Street",
  rd: "Road",
  av: "Avenue",
  ave: "Avenue",
  dr: "Drive",
  cres: "Crescent",
  cr: "Crescent",
  ct: "Court",
  pde: "Parade",
  hwy: "Highway",
  tce: "Terrace",
  bvd: "Boulevard",
  blvd: "Boulevard",
  pl: "Place",
  cl: "Close",
  ln: "Lane",
  esp: "Esplanade",
  cct: "Circuit",
  gr: "Grove",
};

/** "53/152 Palm Meadows Dr" read aloud is "unit 53, 152 Palm Meadows Drive". */
export function sayAddress(address: string): string {
  let a = address.trim().replace(/\s+/g, " ");
  a = a.replace(/\bQLD\b\s*(\d{4})?/g, "").replace(/\b\d{4}\s*$/, "");
  a = a.replace(/^(\d+[a-z]?)\s*\/\s*(\d+)/i, "unit $1, $2");
  const words = a.split(/(\s+|,)/);
  for (let i = 1; i < words.length; i++) {
    const full = STREET_WORDS[words[i]!.toLowerCase()];
    if (!full || !/^[A-Z]/.test(words[i]!)) continue;
    const rest = words.slice(i + 1).join("");
    /* "St" before a capitalised word is as likely Saint as Street, leave it. */
    const atEnd = /^\s*(,|$)/.test(rest);
    if (atEnd || (words[i]!.toLowerCase() !== "st" && /^\s+[A-Z]/.test(rest))) words[i] = full;
  }
  a = words.join("");
  return a.replace(/\s+,/g, ",").replace(/[,\s]+$/, "").trim();
}

const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();

export interface SiteContact {
  name: string;
  firstName: string;
  mobile: string | null;
  phone: string | null;
  role: string;
}

export interface Brief {
  taskId: number;
  jobId: number;
  jobNumber: number;
  title: string;
  description: string | null;
  status: string;
  areaM2: number | null;
  skillName: string | null;
  furnitureOnSite: boolean;
  accessNotes: string[];
  customerName: string | null;
  street: string | null;
  suburb: string | null;
  /** One line a maps app can find. */
  destination: string | null;
  contact: SiteContact | null;
  startTime: string | null;
}

/** Everything about one task Siri may say. Caller has already checked it is theirs. */
export async function briefFor(taskId: number): Promise<Brief | null> {
  const [row] = await db
    .select({
      taskId: schema.jobTasks.id,
      jobId: schema.jobTasks.jobId,
      title: schema.jobTasks.title,
      description: schema.jobTasks.description,
      status: schema.jobTasks.status,
      areaM2: schema.jobTasks.areaM2,
      startTime: schema.jobTasks.startTime,
      skillName: schema.skills.name,
      jobNumber: schema.jobs.number,
      jobContactId: schema.jobs.contactId,
      furnitureOnSite: schema.jobs.furnitureOnSite,
      jobAccess: schema.jobs.accessNotes,
      address: schema.sites.address,
      suburb: schema.sites.suburb,
      postcode: schema.sites.postcode,
      state: schema.sites.state,
      siteAccess: schema.sites.accessNotes,
    })
    .from(schema.jobTasks)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(eq(schema.jobTasks.id, taskId));
  if (!row) return null;

  /* The person to text or ring about today: the first person ticked Show to
   * Crew, Site access ranked first (lib/crew-people.ts). Never the company. */
  const people = (await crewPeopleFor([row.jobId])).get(row.jobId) ?? [];
  const first = people[0];
  const contact: SiteContact | null = first
    ? { name: first.name, firstName: first.firstName, mobile: first.mobile, phone: first.phone, role: first.label }
    : null;

  // The job's name as crew say it ("the Smith job"). The customer's own name
  // only, never the billing company.
  let customerName: string | null = null;
  if (row.jobContactId) {
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, row.jobContactId));
    if (c) customerName = fullName(c) || null;
  }

  const street = row.address?.trim() || null;
  const suburb = row.suburb?.trim() || null;
  const destination = street
    ? [
        street,
        [suburb && !street.toLowerCase().includes(suburb.toLowerCase()) ? suburb : null, row.state?.trim() || "QLD", row.postcode]
          .filter(Boolean)
          .join(" "),
        "Australia",
      ].join(", ")
    : null;

  return {
    taskId: row.taskId,
    jobId: row.jobId,
    jobNumber: row.jobNumber,
    title: row.title,
    description: row.description,
    status: row.status,
    areaM2: row.areaM2,
    skillName: row.skillName,
    furnitureOnSite: row.furnitureOnSite,
    accessNotes: [row.siteAccess, row.jobAccess].map((s) => s?.trim()).filter((s): s is string => Boolean(s)),
    customerName,
    street,
    suburb,
    destination,
    contact,
    startTime: row.startTime,
  };
}

/** "the Raman job at 11 Spinebill Street, Burleigh Waters". */
export function sayPlace(b: Brief): string {
  const where = b.street ? sayAddress([b.street, b.suburb && !b.street.includes(b.suburb) ? b.suburb : null].filter(Boolean).join(", ")) : null;
  const who = b.customerName ? `the ${b.customerName.split(/\s+/).slice(-1)[0]} job` : `job ${b.jobNumber}`;
  return where ? `${who} at ${where}` : who;
}

/** Short form for a text message: the street, or the job number. */
export const textPlace = (b: Brief) => b.street ?? `job ${b.jobNumber}`;

/** Short form for an office note: "the Raman job (#4430)". */
export const officePlace = (b: Brief) =>
  `${b.customerName ? `the ${b.customerName} job` : "job"} #${b.jobNumber}${b.street ? `, ${b.street}` : ""}`;

export function sayWhen(day: WorkDay, b: Brief, today = todayLocal()): string {
  const d = sayDay(day.date, today);
  if (day.coordinate) return `${d}, time to be sorted with the site`;
  const s = sayTime(day.arrivalStart ?? b.startTime);
  const e = sayTime(day.arrivalEnd);
  if (s && e) return `${d}, arriving between ${s} and ${e}`;
  if (s) return `${d} at ${s}`;
  return d;
}

/** The instant they are booked to turn up, for working out how late they are. */
export const bookedStart = (day: WorkDay, b: Brief) => localTimeOn(day.date, day.arrivalStart ?? b.startTime);

/**
 * The next job, Gold Coast time. Skips the task they are standing at right
 * now (an open site visit), because "what's my next job" from a site means
 * the one after this.
 */
export async function nextWorkDay(installerId: number): Promise<{ day: WorkDay; brief: Brief } | null> {
  const today = todayLocal();
  const days = await workDaysFor(installerId, today, addLocalDays(today, 14));
  if (days.length === 0) return null;

  const here = await db
    .select({ taskId: schema.siteVisits.taskId })
    .from(schema.siteVisits)
    .where(
      and(
        eq(schema.siteVisits.installerId, installerId),
        isNull(schema.siteVisits.leftAt),
        isNull(schema.siteVisits.voidedAt),
        inArray(
          schema.siteVisits.taskId,
          days.map((d) => d.taskId),
        ),
      ),
    )
    .orderBy(asc(schema.siteVisits.arrivedAt));
  const hereIds = new Set(here.map((h) => h.taskId));

  const briefs = new Map<number, Brief | null>();
  const withTimes: { day: WorkDay; brief: Brief; sort: string }[] = [];
  for (const d of days) {
    if (!briefs.has(d.taskId)) briefs.set(d.taskId, await briefFor(d.taskId));
    const b = briefs.get(d.taskId);
    if (!b) continue;
    withTimes.push({ day: d, brief: b, sort: `${d.date} ${(d.arrivalStart ?? b.startTime ?? "99:99").padStart(5, "0")}` });
  }
  withTimes.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  const pick = withTimes.find((w) => !(w.day.date === today && hereIds.has(w.day.taskId))) ?? withTimes[0];
  return pick ? { day: pick.day, brief: pick.brief } : null;
}

/** The job they are at, or failing that the one they are heading to. */
export async function currentOrNext(installerId: number): Promise<{ day: WorkDay | null; brief: Brief } | null> {
  const [open] = await db
    .select({ taskId: schema.siteVisits.taskId })
    .from(schema.siteVisits)
    .where(
      and(eq(schema.siteVisits.installerId, installerId), isNull(schema.siteVisits.leftAt), isNull(schema.siteVisits.voidedAt)),
    )
    .orderBy(asc(schema.siteVisits.arrivedAt))
    .limit(1);
  if (open) {
    const b = await briefFor(open.taskId);
    if (b && b.status !== "complete" && b.status !== "cancelled") {
      const today = todayLocal();
      const [day] = await workDaysFor(installerId, today, today).then((ds) => ds.filter((d) => d.taskId === open.taskId));
      return { day: day ?? null, brief: b };
    }
  }
  /* A task already running today counts as "this job" even without a visit. */
  const today = todayLocal();
  const todays = await workDaysFor(installerId, today, today, ["in_progress"]);
  if (todays[0]) {
    const b = await briefFor(todays[0].taskId);
    if (b) return { day: todays[0], brief: b };
  }
  return nextWorkDay(installerId);
}
