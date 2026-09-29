import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/* ---------------------------------------------------------------------------
 * Segments — who a message is allowed to go to.
 *
 * A segment is a saved question about the contact book, not a saved list. It is
 * re-run every time it is read, so a contact who unsubscribes today drops out of
 * every segment today, with nothing to refresh by hand.
 *
 * Two counts come back from every segment and the office sees both:
 *
 *   matching    people who fit the rules
 *   reachable   people who fit the rules AND may lawfully be emailed
 *
 * They are never the same number and the gap is the point. A segment of 300
 * that can only be mailed to 40 is a consent problem, and hiding it behind one
 * number is how a business ends up sending to the other 260.
 * ------------------------------------------------------------------------- */

export type Audience = "homeowner" | "builder";

export interface SegmentRules {
  /** contacts.suburb, matched case-insensitively. Empty means anywhere. */
  suburbs?: string[];
  /** Product families, matched against the free-text job category. */
  products?: string[];
  /** Last completed job inside this many days. */
  completedWithinDays?: number | null;
  /** Last completed job longer ago than this. The dormant case. */
  completedBeforeDays?: number | null;
  /** contacts.source. Thin data today, kept because imports will improve. */
  sources?: string[];
  /** Total value of their completed jobs, dollars. */
  minJobValue?: number | null;
  /** Off only for a list being exported for post or phone. */
  requireEmail?: boolean;
}

/* ---------------------------------------------------------------------------
 * Product families
 *
 * `jobs.category` is whatever the office typed into ServiceM8 across ten years:
 * "carpet", "broadloom carpet install", "Broadloom carpet...", "Carpet & Vinyl".
 * Matching it exactly would give the office a dropdown of 60 near-duplicates and
 * a segment that quietly misses half the people it should find. So the rules
 * work on families of keywords instead, and the messy values collapse into the
 * six things Terra actually installs.
 * ------------------------------------------------------------------------- */

export const PRODUCT_FAMILIES = [
  { key: "carpet", label: "Carpet", like: ["%carpet%"], not: ["%carpet tile%"] },
  { key: "carpet_tiles", label: "Carpet tiles", like: ["%carpet tile%"], not: [] },
  { key: "vinyl", label: "Vinyl", like: ["%vinyl%"], not: [] },
  { key: "hybrid", label: "Hybrid", like: ["%hybrid%"], not: [] },
  { key: "timber", label: "Timber", like: ["%timber%", "%floorboard%", "%sand and coat%"], not: [] },
  { key: "laminate", label: "Laminate", like: ["%laminate%"], not: [] },
] as const;

export type ProductFamily = (typeof PRODUCT_FAMILIES)[number]["key"];

/** The SQL for "this job is of this family", built off the family's keywords. */
function familyCondition(key: string): SQL | null {
  const fam = PRODUCT_FAMILIES.find((f) => f.key === key);
  if (!fam) return null;

  const cat = sql`lower(coalesce(${schema.jobs.category}, '') || ' ' || coalesce(${schema.jobs.title}, ''))`;
  const hits = fam.like.map((p) => sql`${cat} like ${p}`);
  const misses = fam.not.map((p) => sql`${cat} not like ${p}`);

  const any = sql.join(hits, sql` or `);
  if (misses.length === 0) return sql`(${any})`;
  return sql`((${any}) and ${sql.join(misses, sql` and `)})`;
}

/* ---------------------------------------------------------------------------
 * Rule parsing
 * ------------------------------------------------------------------------- */

const asStrings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : undefined;

const asNumber = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/** Never throws. A corrupt rules blob becomes an empty rule set, not an error. */
export function parseRules(raw: string | null | undefined): SegmentRules {
  let obj: Record<string, unknown> = {};
  try {
    const v = JSON.parse(raw || "{}");
    if (v && typeof v === "object") obj = v as Record<string, unknown>;
  } catch {
    obj = {};
  }

  return {
    suburbs: asStrings(obj.suburbs),
    products: asStrings(obj.products)?.filter((p) => PRODUCT_FAMILIES.some((f) => f.key === p)),
    completedWithinDays: asNumber(obj.completedWithinDays),
    completedBeforeDays: asNumber(obj.completedBeforeDays),
    sources: asStrings(obj.sources),
    minJobValue: asNumber(obj.minJobValue),
    requireEmail: obj.requireEmail === false ? false : true,
  };
}

/** Plain English, for the segment list and the send confirmation screen. */
export function describeRules(rules: SegmentRules, audience: Audience): string {
  const bits: string[] = [audience === "builder" ? "Builders" : "Homeowners"];

  if (rules.products?.length) {
    const labels = rules.products.map(
      (p) => PRODUCT_FAMILIES.find((f) => f.key === p)?.label ?? p,
    );
    bits.push(`who had ${labels.join(" or ")} installed`);
  }
  if (rules.suburbs?.length) {
    bits.push(
      rules.suburbs.length <= 3
        ? `in ${rules.suburbs.join(", ")}`
        : `in ${rules.suburbs.length} suburbs`,
    );
  }
  if (rules.completedWithinDays) bits.push(`finished in the last ${rules.completedWithinDays} days`);
  if (rules.completedBeforeDays) bits.push(`not seen for ${rules.completedBeforeDays}+ days`);
  if (rules.sources?.length) bits.push(`from ${rules.sources.join(", ")}`);
  if (rules.minJobValue) bits.push(`worth $${rules.minJobValue.toLocaleString()}+`);
  if (rules.requireEmail === false) bits.push("email not required");

  return bits.join(", ");
}

/* ---------------------------------------------------------------------------
 * Matching
 * ------------------------------------------------------------------------- */

/**
 * Contacts carry no company_id, so "is this a builder" is answered through
 * their jobs: any job attached to a company makes them trade, and a journey
 * must never touch them.
 */
const tradesAsCompany = sql`exists (
  select 1 from ${schema.jobs} j
  where j.contact_id = ${schema.contacts.id} and j.company_id is not null
)`;

function ruleConditions(rules: SegmentRules, audience: Audience): SQL[] {
  const where: SQL[] = [sql`${schema.contacts.active} = 1`];

  where.push(audience === "builder" ? tradesAsCompany : sql`not ${tradesAsCompany}`);

  if (rules.requireEmail !== false) {
    where.push(sql`trim(coalesce(${schema.contacts.email}, '')) != ''`);
  }

  if (rules.suburbs?.length) {
    const wanted = rules.suburbs.map((s) => s.trim().toLowerCase());
    where.push(inArray(sql`lower(trim(coalesce(${schema.contacts.suburb}, '')))`, wanted));
  }

  if (rules.sources?.length) {
    where.push(inArray(schema.contacts.source, rules.sources));
  }

  if (rules.completedWithinDays) {
    const since = new Date(Date.now() - rules.completedWithinDays * 86_400_000);
    where.push(
      and(
        isNotNull(schema.contacts.lastCompletedAt),
        gte(schema.contacts.lastCompletedAt, since),
      )!,
    );
  }

  if (rules.completedBeforeDays) {
    const before = new Date(Date.now() - rules.completedBeforeDays * 86_400_000);
    where.push(
      and(
        isNotNull(schema.contacts.lastCompletedAt),
        lte(schema.contacts.lastCompletedAt, before),
      )!,
    );
  }

  if (rules.products?.length) {
    const fams = rules.products
      .map((p) => familyCondition(p))
      .filter((c): c is SQL => c !== null);

    if (fams.length) {
      /* The family test runs against the contact's completed jobs only. A
       * quote for timber they never went ahead with is not a timber customer. */
      where.push(sql`exists (
        select 1 from ${schema.jobs}
        where ${schema.jobs.contactId} = ${schema.contacts.id}
          and ${schema.jobs.completedAt} is not null
          and (${sql.join(fams, sql` or `)})
      )`);
    }
  }

  if (rules.minJobValue) {
    where.push(sql`(
      select coalesce(sum(${schema.jobs.value}), 0) from ${schema.jobs}
      where ${schema.jobs.contactId} = ${schema.contacts.id}
        and ${schema.jobs.completedAt} is not null
    ) >= ${rules.minJobValue}`);
  }

  return where;
}

/**
 * The consent half of the where clause, in SQL rather than per-contact calls.
 *
 * It must stay in step with `checkConsent` in lib/marketing.ts, which is the
 * real gate every send passes through. This one exists so the office can be
 * shown a reachable count without 1,600 round trips; marketing.ts is what
 * actually decides. If they ever disagree, marketing.ts wins and nothing
 * unlawful goes out — the count is just optimistic, which is why the tests
 * check them against each other.
 */
function consentConditions(): SQL[] {
  return [
    sql`${schema.contacts.doNotMarket} = 0`,
    sql`(${schema.contacts.marketingOptIn} = 1 or ${schema.contacts.marketingBasis} = 'completed_job')`,
    sql`trim(coalesce(${schema.contacts.email}, '')) != ''`,
    sql`not exists (
      select 1 from ${schema.unsubscribes} u
      where (u.contact_id = ${schema.contacts.id}
             or (u.email != '' and lower(u.email) = lower(trim(coalesce(${schema.contacts.email}, '')))))
        and u.channel in ('all', 'email')
    )`,
    /* A contact whose jobs belong to a company is a builder. Belt and braces:
     * the audience clause already excludes them from a homeowner segment. */
  ];
}

export interface SegmentCounts {
  matching: number;
  reachable: number;
  /** Why the rest cannot be mailed. Sums to matching minus reachable. */
  blocked: { noEmail: number; noConsent: number; doNotMarket: number; unsubscribed: number };
}

const count = async (where: SQL[]) => {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.contacts)
    .where(and(...where));
  return Number(row?.n ?? 0);
};

export async function segmentCounts(
  rules: SegmentRules,
  audience: Audience,
): Promise<SegmentCounts> {
  const base = ruleConditions(rules, audience);

  const [matching, reachable, noEmail, doNotMarket, unsubscribed, noBasis] = await Promise.all([
    count(base),
    count([...base, ...consentConditions()]),
    count([...base, sql`trim(coalesce(${schema.contacts.email}, '')) = ''`]),
    count([...base, sql`${schema.contacts.doNotMarket} = 1`]),
    count([
      ...base,
      sql`exists (
        select 1 from ${schema.unsubscribes} u
        where (u.contact_id = ${schema.contacts.id}
               or (u.email != '' and lower(u.email) = lower(trim(coalesce(${schema.contacts.email}, '')))))
          and u.channel in ('all', 'email')
      )`,
    ]),
    count([
      ...base,
      sql`${schema.contacts.doNotMarket} = 0`,
      sql`${schema.contacts.marketingOptIn} = 0`,
      sql`${schema.contacts.marketingBasis} != 'completed_job'`,
    ]),
  ]);

  return {
    matching,
    reachable,
    blocked: { noEmail, noConsent: noBasis, doNotMarket, unsubscribed },
  };
}

export interface SegmentMember {
  id: number;
  name: string;
  email: string | null;
  suburb: string | null;
  lastCompletedAt: Date | null;
  reachable: boolean;
}

/** A sample of who is in the segment, so the office can sanity-check the rules. */
export async function segmentSample(
  rules: SegmentRules,
  audience: Audience,
  limit = 25,
): Promise<SegmentMember[]> {
  const base = ruleConditions(rules, audience);

  const rows = await db
    .select({
      id: schema.contacts.id,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
      email: schema.contacts.email,
      suburb: schema.contacts.suburb,
      lastCompletedAt: schema.contacts.lastCompletedAt,
      doNotMarket: schema.contacts.doNotMarket,
      marketingOptIn: schema.contacts.marketingOptIn,
      marketingBasis: schema.contacts.marketingBasis,
    })
    .from(schema.contacts)
    .where(and(...base))
    .orderBy(sql`${schema.contacts.lastCompletedAt} desc nulls last`)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    name: `${r.firstName} ${r.lastName}`.trim(),
    email: r.email,
    suburb: r.suburb,
    lastCompletedAt: r.lastCompletedAt,
    reachable:
      !r.doNotMarket &&
      (r.marketingOptIn || r.marketingBasis === "completed_job") &&
      Boolean((r.email ?? "").trim()),
  }));
}

/** Every contact id in the segment that may lawfully be emailed. For a blast. */
export async function reachableIds(rules: SegmentRules, audience: Audience): Promise<number[]> {
  const rows = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(...ruleConditions(rules, audience), ...consentConditions()));
  return rows.map((r) => r.id);
}

/* ---------------------------------------------------------------------------
 * Options for the editor
 *
 * Real counts against real data, so the office picks a suburb that has people
 * in it instead of guessing and getting a segment of nought.
 * ------------------------------------------------------------------------- */

export async function segmentOptions() {
  const suburbs = await db
    .select({ value: schema.contacts.suburb, n: sql<number>`count(*)` })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.active, true),
        isNotNull(schema.contacts.suburb),
        sql`trim(${schema.contacts.suburb}) != ''`,
      ),
    )
    .groupBy(schema.contacts.suburb)
    .orderBy(sql`count(*) desc`)
    .limit(60);

  const sources = await db
    .select({ value: schema.contacts.source, n: sql<number>`count(*)` })
    .from(schema.contacts)
    .where(eq(schema.contacts.active, true))
    .groupBy(schema.contacts.source)
    .orderBy(sql`count(*) desc`);

  /* How many homeowners each product family would find, today. */
  const products = await Promise.all(
    PRODUCT_FAMILIES.map(async (f) => {
      const n = await count(ruleConditions({ products: [f.key] }, "homeowner"));
      return { key: f.key, label: f.label, n };
    }),
  );

  return {
    suburbs: suburbs.map((s) => ({ value: s.value ?? "", n: Number(s.n) })),
    sources: sources.map((s) => ({ value: s.value, n: Number(s.n) })),
    products,
  };
}

/* ---------------------------------------------------------------------------
 * The rail
 * ------------------------------------------------------------------------- */

/**
 * A builder segment can never be journey-eligible. Enforced on every write,
 * and again in the engine, because a marketing email to a builder Terra
 * subcontracts for is a commercial problem, not a compliance one.
 */
export const journeyEligibleFor = (audience: Audience) => audience === "homeowner";

/** Is this segment safe for the journey engine to use? */
export async function assertJourneyUsable(segmentId: number) {
  const [seg] = await db
    .select()
    .from(schema.segments)
    .where(eq(schema.segments.id, segmentId));
  if (!seg) return { ok: false as const, reason: "segment not found" };
  if (!seg.journeyEligible) return { ok: false as const, reason: "segment is not journey-eligible" };
  if (seg.audience !== "homeowner") return { ok: false as const, reason: "journeys are homeowner-only" };
  return { ok: true as const, segment: seg };
}

/** Kept exported for the tests, which compare it against checkConsent. */
export const __internals = { ruleConditions, consentConditions };
