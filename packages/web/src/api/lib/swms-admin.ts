import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  latestVersions,
  parseJson,
  sdsCatalogue,
  type BlockItem,
  type FrozenBlock,
  type FrozenTemplate,
} from "./swms-content";
import { todayLocal } from "./local-date";

/* ---------------------------------------------------------------------------
 * Office side of the SWMS library: drafts, publishing and the change log.
 *
 * A template row plus its blocks is the draft. Publishing freezes the lot into
 * swms_template_versions, and only that frozen copy ever reaches Crew.
 * ------------------------------------------------------------------------- */

export type Actor = { name: string; role: string };

type TemplateRow = typeof schema.swmsTemplates.$inferSelect;
type BlockRow = typeof schema.swmsBlocks.$inferSelect;

/** JSON with sorted keys, so two copies of the same content compare equal. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined && o[k] !== null)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "item";

export function blockOf(b: BlockRow): FrozenBlock {
  return {
    key: b.key,
    title: b.title,
    task: b.task,
    ppe: parseJson<string[]>(b.ppe, []),
    items: parseJson<BlockItem[]>(b.items, []),
  };
}

/** The draft as it would be frozen if published now. Archived blocks are left out. */
export function freezeTemplate(t: TemplateRow, blocks: Map<number, BlockRow>): FrozenTemplate {
  const ids = parseJson<number[]>(t.blockIds, []);
  return {
    key: t.key,
    name: t.name,
    workType: t.workType,
    activity: t.activity,
    ppe: parseJson<string[]>(t.ppe, []),
    everyJob: t.everyJob,
    blocks: ids
      .map((id) => blocks.get(id))
      .filter((b): b is BlockRow => Boolean(b && !b.archivedAt))
      .map(blockOf),
  };
}

export async function logChange(
  entityType: "template" | "block" | "site_check" | "sds" | "job",
  entityId: number | null,
  action: string,
  summary: string,
  actor: Actor,
) {
  try {
    await db.insert(schema.swmsChanges).values({
      entityType,
      entityId,
      action,
      summary,
      actorName: actor.name || "Someone",
      actorRole: actor.role,
    });
  } catch {
    /* tables not there yet: nothing to log into */
  }
}

/** True once the Stage 2 tables exist. */
export async function tablesReady(): Promise<boolean> {
  try {
    await db.select({ id: schema.swmsTemplates.id }).from(schema.swmsTemplates).limit(1);
    return true;
  } catch {
    return false;
  }
}

export async function allBlocks() {
  const rows = await db.select().from(schema.swmsBlocks).orderBy(schema.swmsBlocks.title);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Everything the editor page shows, in one go. */
export async function libraryOverview() {
  if (!(await tablesReady())) return { ready: false as const };
  const [templates, blocks, checks, versions, catalogue, docs] = await Promise.all([
    db.select().from(schema.swmsTemplates).orderBy(schema.swmsTemplates.sortOrder, schema.swmsTemplates.id),
    allBlocks(),
    db.select().from(schema.swmsSiteChecks).orderBy(schema.swmsSiteChecks.sortOrder, schema.swmsSiteChecks.id),
    latestVersions(),
    sdsCatalogue(),
    db
      .select({ code: schema.safetyDocs.code, issuedOn: schema.safetyDocs.issuedOn, reviewOn: schema.safetyDocs.reviewOn })
      .from(schema.safetyDocs)
      .where(and(eq(schema.safetyDocs.active, true), eq(schema.safetyDocs.kind, "sds"))),
  ]);
  const versionCount = new Map<number, number>();
  for (const v of await db.select({ templateId: schema.swmsTemplateVersions.templateId }).from(schema.swmsTemplateVersions))
    versionCount.set(v.templateId, (versionCount.get(v.templateId) ?? 0) + 1);

  const usedBy = new Map<number, string[]>();
  const tpls = templates.map((t) => {
    const blockIds = parseJson<number[]>(t.blockIds, []);
    if (!t.archivedAt) for (const id of blockIds) usedBy.set(id, [...(usedBy.get(id) ?? []), t.name]);
    const latest = versions.get(t.id) ?? null;
    const draft = freezeTemplate(t, blocks);
    const changed = latest ? stableJson(parseJson(latest.content, null)) !== stableJson(draft) : true;
    const sdsCodes = new Set<string>();
    if (latest) for (const b of parseJson<FrozenTemplate | null>(latest.content, null)?.blocks ?? []) for (const i of b.items) if (i.sds) sdsCodes.add(i.sds);
    return {
      id: t.id,
      key: t.key,
      name: t.name,
      workType: t.workType,
      activity: t.activity,
      ppe: parseJson<string[]>(t.ppe, []),
      blockIds,
      everyJob: t.everyJob,
      matchTerms: parseJson<string[]>(t.matchTerms, []),
      categoryTerms: parseJson<string[]>(t.categoryTerms, []),
      alsoAdds: parseJson<string[]>(t.alsoAdds, []),
      replacesKey: t.replacesKey,
      sortOrder: t.sortOrder,
      archived: Boolean(t.archivedAt),
      updatedByName: t.updatedByName,
      updatedAt: t.updatedAt,
      status: (!latest ? "draft" : changed ? "changed" : "published") as "draft" | "changed" | "published",
      versions: versionCount.get(t.id) ?? 0,
      latest: latest
        ? {
            version: latest.version,
            publishedAt: latest.publishedAt,
            publishedByName: latest.publishedByName,
            whatChanged: latest.whatChanged,
            reviewedByName: latest.reviewedByName,
            reviewedByQualification: latest.reviewedByQualification,
            reviewedOn: latest.reviewedOn,
          }
        : null,
      liveSds: [...sdsCodes],
    };
  });

  const today = todayLocal();
  const current = new Map<string, { reviewOn: string | null }>();
  for (const d of docs) {
    const review = d.reviewOn ?? (d.issuedOn && /^\d{4}-\d{2}-\d{2}/.test(d.issuedOn) ? `${Number(d.issuedOn.slice(0, 4)) + 5}${d.issuedOn.slice(4, 10)}` : null);
    if (!current.has(d.code)) current.set(d.code, { reviewOn: review });
  }
  const productName = (c: string) => catalogue.find((x) => x.code === c)?.product ?? c;
  const warnings: Array<{ kind: "missing_sds" | "expired_sds"; code: string; product: string; templates: string[]; reviewOn?: string | null }> = [];
  const liveCodes = new Map<string, string[]>();
  for (const t of tpls) if (!t.archived && t.latest) for (const c of t.liveSds) liveCodes.set(c, [...(liveCodes.get(c) ?? []), t.name]);
  for (const [code, names] of liveCodes) {
    const d = current.get(code);
    if (!d) warnings.push({ kind: "missing_sds", code, product: productName(code), templates: names });
    else if (d.reviewOn && d.reviewOn < today) warnings.push({ kind: "expired_sds", code, product: productName(code), templates: names, reviewOn: d.reviewOn });
  }

  return {
    ready: true as const,
    templates: tpls,
    blocks: [...blocks.values()].map((b) => ({
      id: b.id,
      key: b.key,
      title: b.title,
      task: b.task,
      ppe: parseJson<string[]>(b.ppe, []),
      items: parseJson<BlockItem[]>(b.items, []),
      archived: Boolean(b.archivedAt),
      usedBy: usedBy.get(b.id) ?? [],
      updatedByName: b.updatedByName,
      updatedAt: b.updatedAt,
    })),
    siteChecks: checks.map((c) => ({
      id: c.id,
      question: c.question,
      answers: parseJson<string[]>(c.answers, []),
      flagOn: parseJson<string[]>(c.flagOn, []),
      blocks: c.blocks,
      appliesAll: c.appliesAll,
      templateKeys: parseJson<string[]>(c.templateKeys, []),
      sortOrder: c.sortOrder,
      archived: Boolean(c.archivedAt),
    })),
    sds: catalogue,
    warnings,
  };
}

/** A fresh key nobody has used, from a name. */
export async function freshKey(table: "block" | "template", base: string) {
  const s = slug(base);
  const rows =
    table === "block"
      ? await db.select({ key: schema.swmsBlocks.key }).from(schema.swmsBlocks)
      : await db.select({ key: schema.swmsTemplates.key }).from(schema.swmsTemplates);
  const taken = new Set(rows.map((r) => r.key));
  if (!taken.has(s)) return s;
  for (let n = 2; ; n++) if (!taken.has(`${s}_${n}`)) return `${s}_${n}`;
}

/** Give new items an id from the block key and label. Existing ids never change. */
export function idItems(blockKey: string, items: Array<Omit<BlockItem, "id"> & { id?: string | null }>): BlockItem[] {
  const used = new Set(items.map((i) => i.id).filter((x): x is string => Boolean(x)));
  return items.map((i) => {
    if (i.id) return { ...i, id: i.id };
    const base = `${blockKey}.${slug(i.label)}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    return { ...i, id };
  });
}

const lower = (a: string[]) => new Set(a.map((x) => x.trim().toLowerCase()).filter(Boolean));

/**
 * Publish a template. A new frozen version, and on the first publish the
 * template takes over the matching words of the one it replaces. The old one
 * is archived when it has no words left, never deleted.
 */
export async function publishTemplate(
  id: number,
  input: { whatChanged: string; reviewedByName: string; reviewedByQualification: string; reviewedOn: string | null },
  actor: Actor,
) {
  const [t] = await db.select().from(schema.swmsTemplates).where(eq(schema.swmsTemplates.id, id));
  if (!t) throw new Error("Template not found");
  if (t.archivedAt) throw new Error("Restore the template before publishing it.");
  const frozen = freezeTemplate(t, await allBlocks());
  const itemCount = frozen.blocks.reduce((n, b) => n + b.items.length, 0);
  if (!itemCount) throw new Error("Add at least one task block with a hazard before publishing.");

  const [last] = await db
    .select()
    .from(schema.swmsTemplateVersions)
    .where(eq(schema.swmsTemplateVersions.templateId, id))
    .orderBy(desc(schema.swmsTemplateVersions.version))
    .limit(1);
  if (last && stableJson(parseJson(last.content, null)) === stableJson(frozen))
    throw new Error("Nothing has changed since the last version.");
  const version = (last?.version ?? 0) + 1;
  const at = new Date();
  await db.insert(schema.swmsTemplateVersions).values({
    templateId: id,
    version,
    content: JSON.stringify(frozen),
    whatChanged: input.whatChanged.trim(),
    publishedByName: actor.name,
    publishedAt: at,
    reviewedByName: input.reviewedByName.trim(),
    reviewedByQualification: input.reviewedByQualification.trim(),
    reviewedOn: input.reviewedOn || null,
  });
  await logChange("template", id, "published", `Published ${t.name} version ${version}. ${input.whatChanged.trim()}`, actor);

  let replaced: { key: string; name: string; archived: boolean } | null = null;
  if (!last && t.replacesKey) {
    const [old] = await db
      .select()
      .from(schema.swmsTemplates)
      .where(and(eq(schema.swmsTemplates.key, t.replacesKey), isNull(schema.swmsTemplates.archivedAt)));
    if (old && old.id !== t.id) {
      const mine = lower(parseJson<string[]>(t.matchTerms, []));
      const mineCat = lower(parseJson<string[]>(t.categoryTerms, []));
      const keepMatch = parseJson<string[]>(old.matchTerms, []).filter((w) => !mine.has(w.trim().toLowerCase()));
      const keepCat = parseJson<string[]>(old.categoryTerms, []).filter((w) => !mineCat.has(w.trim().toLowerCase()));
      const archive = keepMatch.length === 0 && keepCat.length === 0;
      await db
        .update(schema.swmsTemplates)
        .set({
          matchTerms: JSON.stringify(keepMatch),
          categoryTerms: JSON.stringify(keepCat),
          archivedAt: archive ? at : null,
          updatedByName: actor.name,
          updatedAt: at,
        })
        .where(eq(schema.swmsTemplates.id, old.id));
      if (archive) await handOver(old.key, t.key, actor);
      replaced = { key: old.key, name: old.name, archived: archive };
      await logChange(
        "template",
        old.id,
        archive ? "replaced" : "words_moved",
        archive
          ? `${t.name} replaced ${old.name}. ${old.name} archived, its signed records are unchanged.`
          : `${t.name} took over some of the words for ${old.name}. ${old.name} still matches: ${keepMatch.join(", ") || "nothing"}.`,
        actor,
      );
    }
  }
  return { version, replaced };
}

/** When a template is archived for a newer one, pins and "always brings in" follow. */
async function handOver(oldKey: string, newKey: string, actor: Actor) {
  const others = await db.select().from(schema.swmsTemplates).where(isNull(schema.swmsTemplates.archivedAt));
  for (const o of others) {
    const adds = parseJson<string[]>(o.alsoAdds, []);
    if (!adds.includes(oldKey)) continue;
    const next = [...new Set(adds.map((k) => (k === oldKey ? newKey : k)))].filter((k) => k !== o.key);
    await db.update(schema.swmsTemplates).set({ alsoAdds: JSON.stringify(next), updatedAt: new Date() }).where(eq(schema.swmsTemplates.id, o.id));
    await logChange("template", o.id, "also_adds", `${o.name} now brings in ${newKey} instead of ${oldKey}.`, actor);
  }
  const pins = await db.select().from(schema.jobSwmsTemplates).where(eq(schema.jobSwmsTemplates.templateKey, oldKey));
  if (!pins.length) return;
  const already = new Set(
    (
      await db
        .select({ jobId: schema.jobSwmsTemplates.jobId })
        .from(schema.jobSwmsTemplates)
        .where(and(eq(schema.jobSwmsTemplates.templateKey, newKey), inArray(schema.jobSwmsTemplates.jobId, pins.map((p) => p.jobId))))
    ).map((r) => r.jobId),
  );
  for (const p of pins) {
    if (already.has(p.jobId)) await db.delete(schema.jobSwmsTemplates).where(eq(schema.jobSwmsTemplates.id, p.id));
    else await db.update(schema.jobSwmsTemplates).set({ templateKey: newKey }).where(eq(schema.jobSwmsTemplates.id, p.id));
  }
}
