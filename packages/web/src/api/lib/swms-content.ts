import { desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { COMMON_HAZARDS, SDS_CATALOGUE, SECTIONS, SECTION_KEYS } from "./swms-library";

/* ---------------------------------------------------------------------------
 * SWMS content as Crew sees it, read from the published templates.
 *
 * The phone still gets the shape it always has: the every-job items as
 * `common`, and one section per template. A section's items are its blocks'
 * items, in block order.
 *
 * If the tables are empty or missing (before the Stage 2 SQL and seed are on
 * live), this falls back to the built-in wording in swms-library.ts, which is
 * exactly what the seed publishes as version 1. Either way Crew sees the same.
 * ------------------------------------------------------------------------- */

export const RISK = ["H", "M", "L"] as const;
export type Risk = (typeof RISK)[number];

export type BlockItem = {
  id: string;
  label: string;
  controls: string;
  riskBefore?: Risk | null;
  riskAfter?: Risk | null;
  /** sds_products.code this item relies on. */
  sds?: string | null;
};

export type FrozenBlock = { key: string; title: string; task: string; ppe: string[]; items: BlockItem[] };

/** A template with its blocks, as frozen into swms_template_versions.content. */
export type FrozenTemplate = {
  key: string;
  name: string;
  workType: string;
  activity: string;
  ppe: string[];
  everyJob: boolean;
  blocks: FrozenBlock[];
};

export type LibSection = {
  key: string;
  title: string;
  task: string;
  items: BlockItem[];
  ppe: string[];
  templateId: number | null;
  version: number | null;
};

export type LibRule = { key: string; matchTerms: string[]; categoryTerms: string[]; alsoAdds: string[] };

export type Library = {
  source: "db" | "code";
  common: BlockItem[];
  /** Which every-job templates and versions made up `common`. */
  commonFrom: Array<{ key: string; name: string; version: number | null }>;
  sections: LibSection[];
  rules: LibRule[];
};

export type SnapshotItem = BlockItem & { checked: boolean };
export type SwmsSnapshot = {
  common: SnapshotItem[];
  commonFrom?: Library["commonFrom"];
  sections: Array<{
    key: string;
    title: string;
    task: string;
    items: SnapshotItem[];
    ppe?: string[];
    version?: number | null;
  }>;
};

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** Flatten a template's blocks into one list of items, first block wins on a repeated id. */
export function itemsOf(t: FrozenTemplate): BlockItem[] {
  const seen = new Set<string>();
  const out: BlockItem[] = [];
  for (const b of t.blocks) for (const i of b.items)
      if (!seen.has(i.id)) {
        seen.add(i.id);
        out.push(i);
      }
  return out;
}

export function ppeOf(t: FrozenTemplate): string[] {
  const out: string[] = [];
  for (const p of [...t.ppe, ...t.blocks.flatMap((b) => b.ppe)]) if (p && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  return out;
}

/* ------------------------------ the code copy ----------------------------- */

/** The rules that were in swms-library.ts, as words. Same matches, see the seed test. */
export const V1_RULES: LibRule[] = [
  { key: "removal", matchTerms: ["removal", "uplift", "strip out"], categoryTerms: [], alsoAdds: [] },
  { key: "sanding_coating", matchTerms: ["sanding", "staining", "coating"], categoryTerms: [], alsoAdds: [] },
  { key: "timber", matchTerms: ["timber install", "timber flooring"], categoryTerms: [], alsoAdds: [] },
  { key: "moisture_seal", matchTerms: ["moisture barrier"], categoryTerms: [], alsoAdds: ["timber"] },
  {
    key: "carpet_broadloom",
    matchTerms: ["broadloom", "direct stick", "carpet stairs", "carpet repairs"],
    categoryTerms: ["carpet"],
    alsoAdds: [],
  },
  { key: "carpet_tiles", matchTerms: ["carpet tiles"], categoryTerms: [], alsoAdds: [] },
  { key: "hybrid", matchTerms: ["hybrid", "vinyl plank", "lvt", "laminate"], categoryTerms: [], alsoAdds: [] },
  { key: "sheet_vinyl", matchTerms: ["vinyl sheet", "safety vinyl", "welding", "coving"], categoryTerms: [], alsoAdds: [] },
  { key: "levelling", matchTerms: ["prep", "levell", "screed", "grinding"], categoryTerms: [], alsoAdds: [] },
];

/** The built-in wording as frozen templates. This is what the seed publishes as version 1. */
export function v1Templates(): Array<FrozenTemplate & { rule: LibRule; sortOrder: number }> {
  const every: FrozenTemplate & { rule: LibRule; sortOrder: number } = {
    key: "every_job",
    name: "Every job",
    workType: "All work",
    activity: "The hazards on every job, whatever the trade.",
    ppe: [],
    everyJob: true,
    blocks: [{ key: "every_job", title: "Every job", task: "", ppe: [], items: COMMON_HAZARDS.map((i) => ({ ...i })) }],
    rule: { key: "every_job", matchTerms: [], categoryTerms: [], alsoAdds: [] },
    sortOrder: 0,
  };
  return [
    every,
    ...SECTION_KEYS.map((k, n) => {
      const s = SECTIONS[k];
      return {
        key: k,
        name: s.title,
        workType: s.title,
        activity: s.task,
        ppe: [],
        everyJob: false,
        blocks: [{ key: k, title: s.title, task: s.task, ppe: [], items: s.items.map((i) => ({ ...i })) }],
        rule: V1_RULES.find((r) => r.key === k)!,
        sortOrder: (n + 1) * 10,
      };
    }),
  ];
}

export function codeLibrary(): Library {
  const t = v1Templates();
  return {
    source: "code",
    common: t.filter((x) => x.everyJob).flatMap(itemsOf),
    commonFrom: [{ key: "every_job", name: "Every job", version: null }],
    sections: t
      .filter((x) => !x.everyJob)
      .map((x) => ({ key: x.key, title: x.name, task: x.activity, items: itemsOf(x), ppe: ppeOf(x), templateId: null, version: null })),
    rules: t.filter((x) => !x.everyJob).map((x) => x.rule),
  };
}

/* ------------------------------ the database ------------------------------ */

/** Latest published version per template id. */
export async function latestVersions(templateIds?: number[]) {
  const rows = await db
    .select()
    .from(schema.swmsTemplateVersions)
    .where(templateIds ? inArray(schema.swmsTemplateVersions.templateId, templateIds.length ? templateIds : [-1]) : undefined)
    .orderBy(desc(schema.swmsTemplateVersions.version));
  const out = new Map<number, (typeof rows)[number]>();
  for (const r of rows) if (!out.has(r.templateId)) out.set(r.templateId, r);
  return out;
}

/** What Crew sees right now: every active template that has been published at least once. */
export async function publishedLibrary(): Promise<Library> {
  let templates: Array<typeof schema.swmsTemplates.$inferSelect>;
  let versions: Awaited<ReturnType<typeof latestVersions>>;
  try {
    templates = await db
      .select()
      .from(schema.swmsTemplates)
      .where(isNull(schema.swmsTemplates.archivedAt))
      .orderBy(schema.swmsTemplates.sortOrder, schema.swmsTemplates.id);
    versions = await latestVersions(templates.map((t) => t.id));
  } catch {
    return codeLibrary();
  }
  const live = templates.filter((t) => versions.has(t.id));
  if (!live.length) return codeLibrary();

  const lib: Library = { source: "db", common: [], commonFrom: [], sections: [], rules: [] };
  const commonSeen = new Set<string>();
  for (const t of live) {
    const v = versions.get(t.id)!;
    const frozen = parseJson<FrozenTemplate | null>(v.content, null);
    if (!frozen) continue;
    if (t.everyJob) {
      for (const i of itemsOf(frozen))
        if (!commonSeen.has(i.id)) {
          commonSeen.add(i.id);
          lib.common.push(i);
        }
      lib.commonFrom.push({ key: t.key, name: frozen.name, version: v.version });
      continue;
    }
    lib.sections.push({
      key: t.key,
      title: frozen.name,
      task: frozen.activity,
      items: itemsOf(frozen),
      ppe: ppeOf(frozen),
      templateId: t.id,
      version: v.version,
    });
    lib.rules.push({
      key: t.key,
      matchTerms: parseJson<string[]>(t.matchTerms, []),
      categoryTerms: parseJson<string[]>(t.categoryTerms, []),
      alsoAdds: parseJson<string[]>(t.alsoAdds, []),
    });
  }
  return lib;
}

const hit = (text: string, terms: string[]) => {
  const t = text.toLowerCase();
  return terms.some((w) => w.trim() && t.includes(w.trim().toLowerCase()));
};

/**
 * Which templates a job brings in: from its labour names, then the job
 * category when nothing matched, plus whatever Office pinned on the job.
 */
export function sectionsForLib(
  lib: Library,
  skillNames: Array<string | null | undefined>,
  category?: string | null,
  pinned: string[] = [],
): string[] {
  const out = new Set<string>();
  for (const n of skillNames) {
    if (!n) continue;
    for (const r of lib.rules) if (hit(n, r.matchTerms)) out.add(r.key);
  }
  if (out.size === 0 && category) {
    for (const r of lib.rules) if (hit(category, r.matchTerms)) out.add(r.key);
    if (out.size === 0) for (const r of lib.rules) if (hit(category, r.categoryTerms)) out.add(r.key);
  }
  for (const k of pinned) out.add(k);
  // "Always brings in", one level deep is all the content needs.
  for (const k of Array.from(out)) for (const a of lib.rules.find((r) => r.key === k)?.alsoAdds ?? []) out.add(a);
  return lib.sections.map((s) => s.key).filter((k) => out.has(k));
}

/**
 * The frozen snapshot from what the phone sent: the ids left ticked. Anything
 * the phone did not know about is ignored, so a stale app cannot invent
 * hazards. An item shared by two templates is only kept once.
 */
export function buildSnapshotFrom(
  lib: Library,
  commonChecked: string[],
  sections: Array<{ key: string; checked: string[] }>,
): SwmsSnapshot {
  const tickedCommon = new Set(commonChecked);
  const wanted = new Map<string, Set<string>>();
  for (const s of sections) if (!wanted.has(s.key)) wanted.set(s.key, new Set(s.checked));
  const seen = new Set(lib.common.map((i) => i.id));
  const out: SwmsSnapshot["sections"] = [];
  for (const s of lib.sections) {
    const ticked = wanted.get(s.key);
    if (!ticked) continue;
    const items: SnapshotItem[] = [];
    for (const i of s.items) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      items.push({ ...i, checked: ticked.has(i.id) });
    }
    out.push({ key: s.key, title: s.title, task: s.task, items, ppe: s.ppe, version: s.version });
  }
  return {
    common: lib.common.map((i) => ({ ...i, checked: tickedCommon.has(i.id) })),
    commonFrom: lib.commonFrom,
    sections: out,
  };
}

/** SDS codes a snapshot relies on. Ticked items only. */
export function sdsCodesIn(snap: SwmsSnapshot): string[] {
  const codes = new Set<string>();
  for (const i of snap.common) if (i.checked && i.sds) codes.add(i.sds);
  for (const s of snap.sections) for (const i of s.items) if (i.checked && i.sds) codes.add(i.sds);
  return [...codes];
}

/* --------------------------------- SDS list -------------------------------- */

/** Every SDS product we know: the table, or the built-in list before the seed. */
export async function sdsCatalogue(): Promise<Array<{ id: number | null; code: string; product: string; supplier: string; archived: boolean }>> {
  try {
    const rows = await db.select().from(schema.sdsProducts).orderBy(schema.sdsProducts.product);
    if (rows.length) return rows.map((r) => ({ id: r.id, code: r.code, product: r.product, supplier: r.supplier, archived: r.archived }));
  } catch {
    /* table not there yet */
  }
  return SDS_CATALOGUE.map((c) => ({ ...c, id: null, archived: false }));
}

/** Pinned template keys per job. Empty before the table exists. */
export async function pinnedFor(jobId: number): Promise<string[]> {
  try {
    const rows = await db
      .select({ key: schema.jobSwmsTemplates.templateKey })
      .from(schema.jobSwmsTemplates)
      .where(eq(schema.jobSwmsTemplates.jobId, jobId));
    return rows.map((r) => r.key);
  } catch {
    return [];
  }
}

/** Review date for a sheet: its own, or 5 years after issue. */
export function reviewDate(d: { reviewOn?: string | null; issuedOn?: string | null }): string | null {
  if (d.reviewOn) return d.reviewOn;
  if (!d.issuedOn || !/^\d{4}-\d{2}-\d{2}/.test(d.issuedOn)) return null;
  const y = Number(d.issuedOn.slice(0, 4)) + 5;
  return `${y}${d.issuedOn.slice(4, 10)}`;
}

