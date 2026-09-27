import { z } from "zod";
import { asc } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";

/**
 * PHASE 0 — "what if Runable disappears" insurance.
 *
 * Every bit of Terra Flooring data can be pulled out of here as plain CSV or a
 * full JSON snapshot, by Damien, at any time, with no help from anyone. Nothing
 * in this file is installer-facing — it is all `adminOnly`.
 *
 * The same datasets are dumped nightly by /scripts/backup.ts (see RUNBOOK.md).
 */

/* ------------------------------------------------------------------ csv */

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v).replaceAll('"', '""');
  const s = String(v);
  return s.replaceAll('"', '""');
}

/** RFC4180-ish CSV that Excel and Google Sheets both open cleanly. */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.map((h) => `"${h}"`).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => `"${csvCell(row[h])}"`).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/* -------------------------------------------------------------- datasets */

const DATASETS = {
  jobs: { label: "Jobs", blurb: "Every job with its site, status and value." },
  tasks: { label: "Tasks / dispatches", blurb: "Every dispatch, who it went to and what it paid." },
  contacts: { label: "People", blurb: "Every contact you have ever dealt with." },
  companies: { label: "Companies", blurb: "Builders, agencies and their terms." },
  sites: { label: "Sites", blurb: "Addresses and access notes." },
  installers: { label: "Installers", blurb: "Your crew, capacity, insurance and licence dates." },
  installer_skills: { label: "Installer rates", blurb: "Who is ticked for what, and their rate." },
  quotes: { label: "Quotes", blurb: "Quote headers with totals." },
  quote_items: { label: "Quote lines", blurb: "Every line on every quote." },
  invoices: { label: "Invoices", blurb: "Invoice headers and payment state." },
  products: { label: "Price list", blurb: "Products, cost, sell and margin." },
  job_materials: { label: "Job materials", blurb: "What went on to each job." },
  job_contacts: { label: "Job contacts", blurb: "Who is attached to each job, and their role." },
  skills: { label: "Skills", blurb: "Your skill list." },
  job_statuses: { label: "Job statuses", blurb: "Your status list." },
  settings: { label: "Business rules", blurb: "Key/value settings." },
  activity: { label: "Activity log", blurb: "The audit trail." },
} as const;

type DatasetId = keyof typeof DATASETS;

async function rowsFor(id: DatasetId): Promise<Array<Record<string, unknown>>> {
  switch (id) {
    case "jobs":
      return db.select().from(schema.jobs).orderBy(asc(schema.jobs.id));
    case "tasks":
      return db.select().from(schema.jobTasks).orderBy(asc(schema.jobTasks.id));
    case "contacts":
      return db.select().from(schema.contacts).orderBy(asc(schema.contacts.id));
    case "companies":
      return db.select().from(schema.companies).orderBy(asc(schema.companies.id));
    case "sites":
      return db.select().from(schema.sites).orderBy(asc(schema.sites.id));
    case "installers":
      return db.select().from(schema.installers).orderBy(asc(schema.installers.id));
    case "installer_skills":
      return db.select().from(schema.installerSkills).orderBy(asc(schema.installerSkills.id));
    case "quotes":
      return db.select().from(schema.quotes).orderBy(asc(schema.quotes.id));
    case "quote_items":
      return db.select().from(schema.quoteItems).orderBy(asc(schema.quoteItems.id));
    case "invoices":
      return db.select().from(schema.invoices).orderBy(asc(schema.invoices.id));
    case "products":
      return db.select().from(schema.products).orderBy(asc(schema.products.id));
    case "job_materials":
      return db.select().from(schema.jobMaterials).orderBy(asc(schema.jobMaterials.id));
    case "job_contacts":
      return db.select().from(schema.jobContacts).orderBy(asc(schema.jobContacts.id));
    case "skills":
      return db.select().from(schema.skills).orderBy(asc(schema.skills.id));
    case "job_statuses":
      return db.select().from(schema.jobStatuses).orderBy(asc(schema.jobStatuses.id));
    case "settings":
      return db.select().from(schema.settings).orderBy(asc(schema.settings.key));
    case "activity":
      return db.select().from(schema.activityLog).orderBy(asc(schema.activityLog.id));
  }
}

const datasetId = z.enum(Object.keys(DATASETS) as [DatasetId, ...DatasetId[]]);

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

export const backups = {
  /** What can be exported, with live row counts, for the Settings tab. */
  datasets: adminOnly.handler(async () => {
    const ids = Object.keys(DATASETS) as DatasetId[];
    const counts = await Promise.all(ids.map(async (id) => (await rowsFor(id)).length));
    return ids.map((id, i) => ({
      id,
      label: DATASETS[id].label,
      blurb: DATASETS[id].blurb,
      rows: counts[i] ?? 0,
    }));
  }),

  /** One dataset as CSV text — the browser turns it into a download. */
  csv: adminOnly.input(z.object({ dataset: datasetId })).handler(async ({ input }) => {
    const rows = await rowsFor(input.dataset);
    return {
      filename: `terra-flooring-${input.dataset}-${stamp()}.csv`,
      rows: rows.length,
      csv: toCsv(rows),
    };
  }),

  /** Everything, as one JSON file. This is the restore-from-nothing artefact. */
  snapshot: adminOnly.handler(async () => {
    const ids = Object.keys(DATASETS) as DatasetId[];
    const tables: Record<string, Array<Record<string, unknown>>> = {};
    let total = 0;
    for (const id of ids) {
      const rows = await rowsFor(id);
      tables[id] = rows;
      total += rows.length;
    }
    return {
      filename: `terra-flooring-snapshot-${stamp()}.json`,
      rows: total,
      json: JSON.stringify(
        { business: "Terra Flooring", takenAt: new Date().toISOString(), tables },
        null,
        2,
      ),
    };
  }),
};
