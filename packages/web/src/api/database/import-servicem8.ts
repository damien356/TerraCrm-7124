/**
 * Loads the ServiceM8 payload built by scripts/servicem8-extract.py into Terra
 * Ops. Every filtering decision was already made in that script, so this file
 * only inserts and links.
 *
 *   cd packages/web
 *   bun --env-file=../../.env src/api/database/import-servicem8.ts            # dry run
 *   bun --env-file=../../.env src/api/database/import-servicem8.ts --apply
 *   bun --env-file=../../.env src/api/database/import-servicem8.ts --apply --reset
 *
 * Matching is on external_ref, so a second --apply run updates what it already
 * imported instead of doubling it. Records Damien has since edited by hand keep
 * their edits for anything the import does not own.
 *
 * --reset deletes every imported row first (external_ref is not null), which is
 * the clean way to re-run after changing a rule in the extract script. Terra's
 * own hand-entered records have no external_ref, so they are never touched.
 */

import { readFileSync } from "node:fs";
import { eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "./__client";
import * as schema from "./schema";

type Owner = ["company" | "contact", number] | null;

type Payload = {
  cutoff: string;
  stats: Record<string, number>;
  companies: {
    name: string;
    abn: string | null;
    type: string;
    email: string | null;
    phone: string | null;
    billingAddress: string | null;
    notes: string | null;
    doNotMarket: boolean;
    doNotMarketReason: string | null;
    needsReview: boolean;
    externalRef: string;
  }[];
  contacts: {
    firstName: string;
    lastName: string;
    mobile: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    suburb: string | null;
    postcode: string | null;
    source: string;
    notes: string | null;
    marketingOptIn: boolean;
    marketingBasis: string;
    doNotMarket: boolean;
    doNotMarketReason: string | null;
    lastCompletedAt: string | null;
    needsReview: boolean;
    externalRef: string;
  }[];
  sites: {
    address: string;
    suburb: string;
    state: string;
    postcode: string | null;
    owner: Owner;
  }[];
  jobs: {
    externalRef: string;
    title: string;
    statusName: string;
    owner: Owner;
    siteRef: number | null;
    description: string | null;
    category: string | null;
    value: number;
    completedAt: string | null;
    scheduledStart: string | null;
    poNumber: string | null;
    source: string;
  }[];
};

const PAYLOAD = "/home/user/terra-ops/scripts/servicem8-import.json";
const CHUNK = 200;

const apply = process.argv.includes("--apply");
const reset = process.argv.includes("--reset");

const day = (value: string | null) => (value ? new Date(`${value}T00:00:00Z`) : null);

async function chunked<T, R>(rows: T[], run: (batch: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    out.push(...(await run(rows.slice(i, i + CHUNK))));
  }
  return out;
}

const payload: Payload = JSON.parse(readFileSync(PAYLOAD, "utf8"));

console.log(
  `payload: ${payload.companies.length} companies, ${payload.contacts.length} contacts, ` +
    `${payload.sites.length} sites, ${payload.jobs.length} jobs (cutoff ${payload.cutoff})`,
);

if (!apply) {
  console.log("\ndry run, nothing written. add --apply to import.");
  console.log("extract stats:");
  for (const [k, v] of Object.entries(payload.stats)) console.log(`  ${k}: ${v}`);
  process.exit(0);
}

/* -- clear a previous import ------------------------------------------------ */

if (reset) {
  const importedJobs = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(isNotNull(schema.jobs.externalRef));
  const jobIds = importedJobs.map((j) => j.id);
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const batch = jobIds.slice(i, i + CHUNK);
    await db.delete(schema.jobContacts).where(inArray(schema.jobContacts.jobId, batch));
    await db.delete(schema.jobs).where(inArray(schema.jobs.id, batch));
  }
  await db.delete(schema.sites).where(sql`${schema.sites.label} = 'servicem8'`);
  await db.delete(schema.contacts).where(isNotNull(schema.contacts.externalRef));
  await db.delete(schema.companies).where(isNotNull(schema.companies.externalRef));
  console.log(`reset: removed ${jobIds.length} imported jobs and their clients`);
}

/* -- companies -------------------------------------------------------------- */

const companyIds: number[] = [];
{
  const existing = await db
    .select({ id: schema.companies.id, ref: schema.companies.externalRef })
    .from(schema.companies)
    .where(isNotNull(schema.companies.externalRef));
  const byRef = new Map(existing.map((r) => [r.ref as string, r.id]));

  for (const row of payload.companies) {
    const values = {
      name: row.name,
      abn: row.abn,
      type: row.type,
      email: row.email,
      phone: row.phone,
      billingAddress: row.billingAddress,
      notes: row.notes,
      doNotMarket: row.doNotMarket,
      doNotMarketReason: row.doNotMarketReason,
      needsReview: row.needsReview,
      externalRef: row.externalRef,
    };
    const found = byRef.get(row.externalRef);
    if (found) {
      await db.update(schema.companies).set(values).where(eq(schema.companies.id, found));
      companyIds.push(found);
      continue;
    }
    const [inserted] = await db.insert(schema.companies).values(values).returning({ id: schema.companies.id });
    companyIds.push(inserted.id);
  }
  console.log(`companies: ${companyIds.length} in place`);
}

/* -- contacts --------------------------------------------------------------- */

const contactIds: number[] = [];
{
  const existing = await db
    .select({ id: schema.contacts.id, ref: schema.contacts.externalRef })
    .from(schema.contacts)
    .where(isNotNull(schema.contacts.externalRef));
  const byRef = new Map(existing.map((r) => [r.ref as string, r.id]));

  const fresh = payload.contacts.filter((r) => !byRef.has(r.externalRef));
  const rows = payload.contacts.map((row) => ({
    firstName: row.firstName,
    lastName: row.lastName,
    mobile: row.mobile,
    phone: row.phone,
    email: row.email,
    address: row.address,
    suburb: row.suburb,
    postcode: row.postcode,
    source: row.source,
    notes: row.notes,
    marketingOptIn: row.marketingOptIn,
    marketingBasis: row.marketingBasis,
    doNotMarket: row.doNotMarket,
    doNotMarketReason: row.doNotMarketReason,
    lastCompletedAt: day(row.lastCompletedAt),
    needsReview: row.needsReview,
    externalRef: row.externalRef,
  }));

  // Updates first, then the new ones in batches.
  for (const row of rows) {
    const found = byRef.get(row.externalRef);
    if (found) {
      await db.update(schema.contacts).set(row).where(eq(schema.contacts.id, found));
    }
  }
  const freshRefs = new Set(fresh.map((r) => r.externalRef));
  const inserted = await chunked(
    rows.filter((r) => freshRefs.has(r.externalRef)),
    (batch) => db.insert(schema.contacts).values(batch).returning({ id: schema.contacts.id, ref: schema.contacts.externalRef }),
  );
  for (const r of inserted) byRef.set(r.ref as string, r.id);
  for (const row of payload.contacts) contactIds.push(byRef.get(row.externalRef)!);
  console.log(`contacts: ${contactIds.length} in place (${inserted.length} new)`);
}

const ownerIds = (owner: Owner) => {
  if (!owner) return { contactId: null, companyId: null };
  const [kind, index] = owner;
  return kind === "company"
    ? { contactId: null, companyId: companyIds[index] ?? null }
    : { contactId: contactIds[index] ?? null, companyId: null };
};

/* -- sites ------------------------------------------------------------------ */

const siteIds: number[] = [];
{
  const existing = await db
    .select({ id: schema.sites.id, address: schema.sites.address, suburb: schema.sites.suburb })
    .from(schema.sites);
  const byAddress = new Map(existing.map((r) => [`${r.address}|${r.suburb}`.toLowerCase(), r.id]));

  const fresh: { index: number; values: typeof schema.sites.$inferInsert }[] = [];
  payload.sites.forEach((row, index) => {
    const found = byAddress.get(`${row.address}|${row.suburb}`.toLowerCase());
    if (found !== undefined) {
      siteIds[index] = found;
      return;
    }
    fresh.push({
      index,
      values: {
        // Marks the row as import-owned so --reset can find it again.
        label: "servicem8",
        address: row.address,
        suburb: row.suburb,
        state: row.state,
        postcode: row.postcode,
        ...ownerIds(row.owner),
        propertyType: "residential",
      },
    });
  });

  for (let i = 0; i < fresh.length; i += CHUNK) {
    const batch = fresh.slice(i, i + CHUNK);
    const rows = await db
      .insert(schema.sites)
      .values(batch.map((b) => b.values))
      .returning({ id: schema.sites.id });
    batch.forEach((b, n) => {
      siteIds[b.index] = rows[n].id;
    });
  }
  console.log(`sites: ${siteIds.filter(Boolean).length} in place (${fresh.length} new)`);
}

/* -- jobs ------------------------------------------------------------------- */

{
  const statuses = await db
    .select({ id: schema.jobStatuses.id, name: schema.jobStatuses.name })
    .from(schema.jobStatuses);
  const statusId = new Map(statuses.map((s) => [s.name.toLowerCase(), s.id]));

  const existing = await db
    .select({ id: schema.jobs.id, ref: schema.jobs.externalRef })
    .from(schema.jobs)
    .where(isNotNull(schema.jobs.externalRef));
  const byRef = new Map(existing.map((r) => [r.ref as string, r.id]));

  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${schema.jobs.number}), 200)` })
    .from(schema.jobs);
  let nextNumber = Number(max) + 1;

  // Oldest first, so the local job numbers run in the same order as the history.
  const ordered = [...payload.jobs].sort((a, b) =>
    (a.scheduledStart ?? a.completedAt ?? "").localeCompare(b.scheduledStart ?? b.completedAt ?? ""),
  );

  const fresh: (typeof schema.jobs.$inferInsert)[] = [];
  let updated = 0;
  for (const row of ordered) {
    const owner = ownerIds(row.owner);
    const description = row.poNumber ? `${row.description ?? ""}\n\nPO ${row.poNumber}`.trim() : row.description;
    const values = {
      title: row.title,
      statusId: statusId.get(row.statusName.toLowerCase()) ?? null,
      siteId: row.siteRef === null ? null : (siteIds[row.siteRef] ?? null),
      ...owner,
      billToType: owner.companyId ? "company" : "contact",
      billToContactId: owner.contactId,
      billToCompanyId: owner.companyId,
      description,
      source: row.source,
      value: row.value,
      completedAt: day(row.completedAt),
      scheduledStart: day(row.scheduledStart),
      externalRef: row.externalRef,
      category: row.category,
    };
    const found = byRef.get(row.externalRef);
    if (found) {
      await db.update(schema.jobs).set(values).where(eq(schema.jobs.id, found));
      updated += 1;
      continue;
    }
    fresh.push({ ...values, number: nextNumber++ });
  }

  await chunked(fresh, (batch) => db.insert(schema.jobs).values(batch).returning({ id: schema.jobs.id }));
  console.log(`jobs: ${fresh.length} new, ${updated} updated`);
}

/* -- what landed ------------------------------------------------------------ */

const counts = async (table: string, where: string) => {
  const r = await db.run(sql.raw(`select count(*) as n from ${table} where ${where}`));
  return Number((r.rows[0] as Record<string, unknown>).n);
};

console.log("\nin the database now:");
console.log(`  companies imported      ${await counts("companies", "external_ref is not null")}`);
console.log(`  contacts imported       ${await counts("contacts", "external_ref is not null")}`);
console.log(`  jobs imported           ${await counts("jobs", "external_ref is not null")}`);
console.log(`  sites imported          ${await counts("sites", "label = 'servicem8'")}`);
console.log(`  marketable contacts     ${await counts("contacts", "marketing_basis = 'completed_job' and do_not_market = 0")}`);
console.log(`  awaiting review         ${await counts("contacts", "needs_review = 1")}`);
console.log(`  blocked from marketing  ${await counts("companies", "do_not_market = 1")} companies, ${await counts("contacts", "do_not_market = 1")} contacts`);
