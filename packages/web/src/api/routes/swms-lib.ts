import { z } from "zod";
import { and, desc, eq, ne } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import {
  allBlocks,
  freezeTemplate,
  freshKey,
  idItems,
  libraryOverview,
  logChange,
  publishTemplate,
  tablesReady,
  type Actor,
} from "../lib/swms-admin";
import {
  RISK,
  buildSnapshotFrom,
  itemsOf,
  parseJson,
  pinnedFor,
  ppeOf,
  publishedLibrary,
  sdsCatalogue,
  sectionsForLib,
  type BlockItem,
  type FrozenTemplate,
  type Library,
} from "../lib/swms-content";
import { renderSwmsPdf } from "../lib/swmsPdf";
import { todayLocal } from "../lib/local-date";

/**
 * The SWMS library editor, for Admin and Office. Task blocks, templates, site
 * checks, SDS products, publishing and the change log. Crew never reaches any
 * of this, they only ever get the latest published version through swms.forTask.
 */

const who = (a: { name: string; role: string }): Actor => ({ name: a.name, role: a.role });
const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

async function needTables() {
  if (!(await tablesReady())) throw bad("The SWMS library isn't set up on this database yet.");
}

const words = z.array(z.string().trim().min(1).max(80)).max(40);
const ppe = z.array(z.string().trim().min(1).max(80)).max(30);
const risk = z.enum(RISK).nullable().optional();
const itemInput = z.object({
  id: z.string().max(120).nullable().optional(),
  label: z.string().trim().min(2, "Every hazard needs a name.").max(300),
  controls: z.string().trim().min(2, "Every hazard needs its controls.").max(3000),
  riskBefore: risk,
  riskAfter: risk,
  sds: z.string().max(80).nullable().optional(),
});

async function checkSds(items: Array<{ sds?: string | null }>) {
  const codes = new Set((await sdsCatalogue()).map((c) => c.code));
  const bad_ = items.find((i) => i.sds && !codes.has(i.sds));
  if (bad_) throw bad(`Unknown SDS product "${bad_.sds}".`);
}

async function templateRow(id: number) {
  const [t] = await db.select().from(schema.swmsTemplates).where(eq(schema.swmsTemplates.id, id));
  if (!t) throw new ORPCError("NOT_FOUND", { message: "Template not found" });
  return t;
}

async function blockRow(id: number) {
  const [b] = await db.select().from(schema.swmsBlocks).where(eq(schema.swmsBlocks.id, id));
  if (!b) throw new ORPCError("NOT_FOUND", { message: "Task block not found" });
  return b;
}

/** A one-template library, for the preview. */
function previewLibrary(lib: Library, frozen: FrozenTemplate): Library {
  if (frozen.everyJob) return { ...lib, common: itemsOf(frozen), sections: [] };
  return {
    ...lib,
    sections: [{ key: frozen.key, title: frozen.name, task: frozen.activity, items: itemsOf(frozen), ppe: ppeOf(frozen), templateId: null, version: null }],
  };
}

export const swmsLib = {
  /** Everything the editor page needs. `ready` is false before the Stage 2 tables exist. */
  overview: staffOnly.handler(async () => libraryOverview()),

  /* -------------------------------- blocks -------------------------------- */

  blockSave: staffOnly
    .input(
      z.object({
        id: z.number().nullable().optional(),
        title: z.string().trim().min(2, "Give the block a name.").max(120),
        task: z.string().trim().max(500).default(""),
        ppe: ppe.default([]),
        items: z.array(itemInput).max(60),
      }),
    )
    .handler(async ({ input, context }) => {
      await needTables();
      await checkSds(input.items);
      const actor = who(context.actor);
      const now = new Date();
      if (input.id) {
        const b = await blockRow(input.id);
        // Item ids are what "same as last time" and signed records point at. They never change.
        const items = idItems(b.key, input.items);
        if (new Set(items.map((i) => i.id)).size !== items.length) throw bad("Two hazards in this block share an id.");
        await db
          .update(schema.swmsBlocks)
          .set({ title: input.title, task: input.task, ppe: JSON.stringify(input.ppe), items: JSON.stringify(items), updatedByName: actor.name, updatedAt: now })
          .where(eq(schema.swmsBlocks.id, b.id));
        const was = parseJson<BlockItem[]>(b.items, []);
        const added = items.filter((i) => !was.some((w) => w.id === i.id)).length;
        const removed = was.filter((w) => !items.some((i) => i.id === w.id)).length;
        await logChange(
          "block",
          b.id,
          "edited",
          `Edited ${input.title}.${added ? ` ${added} hazard${added === 1 ? "" : "s"} added.` : ""}${removed ? ` ${removed} removed.` : ""}`,
          actor,
        );
        return { id: b.id };
      }
      const key = await freshKey("block", input.title);
      const [row] = await db
        .insert(schema.swmsBlocks)
        .values({
          key,
          title: input.title,
          task: input.task,
          ppe: JSON.stringify(input.ppe),
          items: JSON.stringify(idItems(key, input.items)),
          updatedByName: actor.name,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.swmsBlocks.id });
      await logChange("block", row!.id, "created", `Created the task block ${input.title}.`, actor);
      return { id: row!.id };
    }),

  blockDuplicate: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    await needTables();
    const b = await blockRow(input.id);
    const actor = who(context.actor);
    const key = await freshKey("block", `${b.key}_copy`);
    const items = parseJson<BlockItem[]>(b.items, []).map((i) => ({ ...i, id: `${key}.${i.id.split(".").pop()}` }));
    const now = new Date();
    const [row] = await db
      .insert(schema.swmsBlocks)
      .values({ key, title: `${b.title} (copy)`, task: b.task, ppe: b.ppe, items: JSON.stringify(items), updatedByName: actor.name, createdAt: now, updatedAt: now })
      .returning({ id: schema.swmsBlocks.id });
    await logChange("block", row!.id, "created", `Copied ${b.title} into a new block.`, actor);
    return { id: row!.id };
  }),

  blockArchive: staffOnly.input(z.object({ id: z.number(), archived: z.boolean() })).handler(async ({ input, context }) => {
    await needTables();
    const b = await blockRow(input.id);
    if (input.archived) {
      const users = (await db.select().from(schema.swmsTemplates)).filter(
        (t) => !t.archivedAt && parseJson<number[]>(t.blockIds, []).includes(b.id),
      );
      if (users.length) throw bad(`Take it out of ${users.map((t) => t.name).join(", ")} first.`);
    }
    await db
      .update(schema.swmsBlocks)
      .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.swmsBlocks.id, b.id));
    await logChange("block", b.id, input.archived ? "archived" : "restored", `${input.archived ? "Archived" : "Restored"} ${b.title}.`, who(context.actor));
    return { ok: true };
  }),

  /* ------------------------------- templates ------------------------------ */

  templateSave: staffOnly
    .input(
      z.object({
        id: z.number().nullable().optional(),
        name: z.string().trim().min(2, "Give the template a name.").max(120),
        workType: z.string().trim().max(120).default(""),
        activity: z.string().trim().max(1000).default(""),
        ppe: ppe.default([]),
        blockIds: z.array(z.number()).max(40),
        matchTerms: words.default([]),
        categoryTerms: words.default([]),
        alsoAdds: z.array(z.string().max(80)).max(10).default([]),
        sortOrder: z.number().int().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      await needTables();
      const actor = who(context.actor);
      const blocks = await allBlocks();
      const missing = input.blockIds.find((id) => !blocks.has(id));
      if (missing) throw bad("One of those task blocks no longer exists.");
      if (new Set(input.blockIds).size !== input.blockIds.length) throw bad("A block is in the list twice.");
      const now = new Date();
      const values = {
        name: input.name,
        workType: input.workType,
        activity: input.activity,
        ppe: JSON.stringify(input.ppe),
        blockIds: JSON.stringify(input.blockIds),
        matchTerms: JSON.stringify(input.matchTerms),
        categoryTerms: JSON.stringify(input.categoryTerms),
        updatedByName: actor.name,
        updatedAt: now,
      };
      if (input.id) {
        const t = await templateRow(input.id);
        const adds = input.alsoAdds.filter((k) => k !== t.key);
        await db
          .update(schema.swmsTemplates)
          .set({ ...values, alsoAdds: JSON.stringify(adds), ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}) })
          .where(eq(schema.swmsTemplates.id, t.id));
        const wordsChanged = t.matchTerms !== values.matchTerms || t.categoryTerms !== values.categoryTerms;
        await logChange(
          "template",
          t.id,
          "edited",
          `Edited ${input.name}.${wordsChanged ? ` Matches: ${input.matchTerms.join(", ") || "nothing"}.` : ""}`,
          actor,
        );
        return { id: t.id };
      }
      const key = await freshKey("template", input.name);
      const [last] = await db.select({ s: schema.swmsTemplates.sortOrder }).from(schema.swmsTemplates).orderBy(desc(schema.swmsTemplates.sortOrder)).limit(1);
      const [row] = await db
        .insert(schema.swmsTemplates)
        .values({ ...values, key, alsoAdds: JSON.stringify(input.alsoAdds), everyJob: false, sortOrder: input.sortOrder ?? (last?.s ?? 0) + 10, createdAt: now })
        .returning({ id: schema.swmsTemplates.id });
      await logChange("template", row!.id, "created", `Created the template ${input.name} as a draft.`, actor);
      return { id: row!.id };
    }),

  templateDuplicate: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    await needTables();
    const t = await templateRow(input.id);
    const actor = who(context.actor);
    const key = await freshKey("template", `${t.key}_copy`);
    const now = new Date();
    const [row] = await db
      .insert(schema.swmsTemplates)
      .values({
        key,
        name: `${t.name} (copy)`,
        workType: t.workType,
        activity: t.activity,
        ppe: t.ppe,
        blockIds: t.blockIds,
        everyJob: false,
        // A copy matches nothing until someone gives it words, so it can't fight the original.
        matchTerms: "[]",
        categoryTerms: "[]",
        alsoAdds: "[]",
        sortOrder: t.sortOrder + 1,
        updatedByName: actor.name,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.swmsTemplates.id });
    await logChange("template", row!.id, "created", `Copied ${t.name} into a new draft.`, actor);
    return { id: row!.id };
  }),

  templateArchive: staffOnly.input(z.object({ id: z.number(), archived: z.boolean() })).handler(async ({ input, context }) => {
    await needTables();
    const t = await templateRow(input.id);
    if (t.everyJob && input.archived) throw bad("The every-job hazards can't be archived.");
    await db
      .update(schema.swmsTemplates)
      .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.swmsTemplates.id, t.id));
    await logChange(
      "template",
      t.id,
      input.archived ? "archived" : "restored",
      input.archived ? `Archived ${t.name}. Crew no longer gets it. Signed records are unchanged.` : `Restored ${t.name}.`,
      who(context.actor),
    );
    return { ok: true };
  }),

  publish: staffOnly
    .input(
      z.object({
        id: z.number(),
        whatChanged: z.string().trim().min(3, "Say what changed, one line is fine.").max(1000),
        reviewedByName: z.string().trim().max(120).default(""),
        reviewedByQualification: z.string().trim().max(200).default(""),
        reviewedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      await needTables();
      try {
        return await publishTemplate(
          input.id,
          {
            whatChanged: input.whatChanged,
            reviewedByName: input.reviewedByName,
            reviewedByQualification: input.reviewedByQualification,
            reviewedOn: input.reviewedOn ?? null,
          },
          who(context.actor),
        );
      } catch (e) {
        throw bad(e instanceof Error ? e.message : "Couldn't publish");
      }
    }),

  /** Every published version of one template, newest first. */
  versions: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await needTables();
    const rows = await db
      .select()
      .from(schema.swmsTemplateVersions)
      .where(eq(schema.swmsTemplateVersions.templateId, input.id))
      .orderBy(desc(schema.swmsTemplateVersions.version));
    return rows.map((r) => ({ ...r, content: parseJson<FrozenTemplate | null>(r.content, null) }));
  }),

  /** The draft as Crew would see it, and optionally a sample PDF. */
  preview: staffOnly.input(z.object({ id: z.number(), pdf: z.boolean().default(false) })).handler(async ({ input, context }) => {
    await needTables();
    const t = await templateRow(input.id);
    const frozen = freezeTemplate(t, await allBlocks());
    const lib = await publishedLibrary();
    const one = previewLibrary(lib, frozen);
    const crew = {
      common: one.common,
      sections: one.sections.map((s) => ({ key: s.key, title: s.title, task: s.task, items: s.items, ppe: s.ppe })),
    };
    if (!input.pdf) return { crew, pdfBase64: null };
    const snapshot = buildSnapshotFrom(
      one,
      one.common.map((i) => i.id),
      one.sections.map((s) => ({ key: s.key, checked: s.items.map((i) => i.id) })),
    );
    const cat = await sdsCatalogue();
    const codes = [...new Set(snapshot.sections.flatMap((s) => s.items).map((i) => i.sds).filter((c): c is string => Boolean(c)))];
    const pdf = await renderSwmsPdf({
      jobNumber: "SAMPLE",
      jobTitle: `Preview of ${frozen.name}, not a signed SWMS`,
      siteAddress: "Sample site, 2/22 Lawrence Dr, Nerang QLD 4211",
      workDate: todayLocal(),
      installerName: "Sample installer",
      signedName: context.actor.name || "Sample",
      signedAt: new Date(),
      kind: "full",
      basedOnDate: null,
      snapshot,
      customHazard: "",
      sds: [],
      missingSds: codes.map((c) => cat.find((x) => x.code === c)?.product ?? c),
      signature: { w: 300, h: 100, strokes: [[20, 70, 60, 30, 100, 70, 140, 30, 180, 70]] },
    });
    return { crew, pdfBase64: Buffer.from(pdf).toString("base64") };
  }),

  /* ------------------------------ site checks ----------------------------- */

  siteCheckSave: staffOnly
    .input(
      z.object({
        id: z.number().nullable().optional(),
        question: z.string().trim().min(5, "Write the question.").max(500),
        answers: z.array(z.enum(["yes", "no", "unsure", "na"])).min(2, "Give at least two answers.").max(4),
        flagOn: z.array(z.enum(["yes", "no", "unsure", "na"])).max(4),
        blocks: z.boolean().default(false),
        appliesAll: z.boolean().default(true),
        templateKeys: z.array(z.string().max(80)).max(40).default([]),
        sortOrder: z.number().int().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      await needTables();
      const actor = who(context.actor);
      if (input.flagOn.some((a) => !input.answers.includes(a))) throw bad("A flagged answer has to be one of the answers.");
      if (!input.appliesAll && !input.templateKeys.length) throw bad("Pick the templates it shows on, or show it on every SWMS.");
      const now = new Date();
      const values = {
        question: input.question,
        answers: JSON.stringify(input.answers),
        flagOn: JSON.stringify(input.flagOn),
        blocks: input.blocks,
        appliesAll: input.appliesAll,
        templateKeys: JSON.stringify(input.appliesAll ? [] : input.templateKeys),
        updatedAt: now,
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      };
      if (input.id) {
        await db.update(schema.swmsSiteChecks).set(values).where(eq(schema.swmsSiteChecks.id, input.id));
        await logChange("site_check", input.id, "edited", `Edited the site check "${input.question}".`, actor);
        return { id: input.id };
      }
      const [last] = await db.select({ s: schema.swmsSiteChecks.sortOrder }).from(schema.swmsSiteChecks).orderBy(desc(schema.swmsSiteChecks.sortOrder)).limit(1);
      const [row] = await db
        .insert(schema.swmsSiteChecks)
        .values({ ...values, sortOrder: input.sortOrder ?? (last?.s ?? 0) + 10, createdAt: now })
        .returning({ id: schema.swmsSiteChecks.id });
      await logChange("site_check", row!.id, "created", `Added the site check "${input.question}".`, actor);
      return { id: row!.id };
    }),

  siteCheckArchive: staffOnly.input(z.object({ id: z.number(), archived: z.boolean() })).handler(async ({ input, context }) => {
    await needTables();
    const [c] = await db.select().from(schema.swmsSiteChecks).where(eq(schema.swmsSiteChecks.id, input.id));
    if (!c) throw new ORPCError("NOT_FOUND", { message: "Site check not found" });
    await db
      .update(schema.swmsSiteChecks)
      .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.swmsSiteChecks.id, c.id));
    await logChange("site_check", c.id, input.archived ? "archived" : "restored", `${input.archived ? "Archived" : "Restored"} "${c.question}".`, who(context.actor));
    return { ok: true };
  }),

  /* ------------------------------ SDS products ---------------------------- */

  sdsProductSave: staffOnly
    .input(
      z.object({
        id: z.number().nullable().optional(),
        product: z.string().trim().min(2, "Name the product.").max(160),
        supplier: z.string().trim().max(160).default(""),
      }),
    )
    .handler(async ({ input, context }) => {
      await needTables();
      const actor = who(context.actor);
      const now = new Date();
      if (input.id) {
        const [p] = await db.select().from(schema.sdsProducts).where(eq(schema.sdsProducts.id, input.id));
        if (!p) throw new ORPCError("NOT_FOUND", { message: "Product not found" });
        await db.update(schema.sdsProducts).set({ product: input.product, supplier: input.supplier, updatedAt: now }).where(eq(schema.sdsProducts.id, p.id));
        await logChange("sds", p.id, "edited", `Renamed ${p.product} to ${input.product}.`, actor);
        return { id: p.id, code: p.code };
      }
      const taken = new Set((await db.select({ code: schema.sdsProducts.code }).from(schema.sdsProducts)).map((r) => r.code));
      const base = input.product.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "product";
      let code = base;
      for (let n = 2; taken.has(code); n++) code = `${base}-${n}`;
      const [row] = await db
        .insert(schema.sdsProducts)
        .values({ code, product: input.product, supplier: input.supplier, createdAt: now, updatedAt: now })
        .returning({ id: schema.sdsProducts.id });
      await logChange("sds", row!.id, "created", `Added the SDS product ${input.product}.`, actor);
      return { id: row!.id, code };
    }),

  sdsProductArchive: staffOnly.input(z.object({ id: z.number(), archived: z.boolean() })).handler(async ({ input, context }) => {
    await needTables();
    const [p] = await db.select().from(schema.sdsProducts).where(eq(schema.sdsProducts.id, input.id));
    if (!p) throw new ORPCError("NOT_FOUND", { message: "Product not found" });
    await db.update(schema.sdsProducts).set({ archived: input.archived, updatedAt: new Date() }).where(eq(schema.sdsProducts.id, p.id));
    await logChange("sds", p.id, input.archived ? "archived" : "restored", `${input.archived ? "Archived" : "Restored"} ${p.product}.`, who(context.actor));
    return { ok: true };
  }),

  /* ------------------------------- change log ----------------------------- */

  changes: staffOnly
    .input(z.object({ entityType: z.string().optional(), entityId: z.number().optional(), limit: z.number().max(500).default(200) }).default({ limit: 200 }))
    .handler(async ({ input }) => {
      if (!(await tablesReady())) return [];
      return db
        .select()
        .from(schema.swmsChanges)
        .where(
          and(
            input.entityType ? eq(schema.swmsChanges.entityType, input.entityType) : undefined,
            input.entityId !== undefined ? eq(schema.swmsChanges.entityId, input.entityId) : undefined,
          ),
        )
        .orderBy(desc(schema.swmsChanges.createdAt), desc(schema.swmsChanges.id))
        .limit(input.limit);
    }),

  /* ------------------------------- job pins ------------------------------- */

  /** Which templates a job brings in, from its labour and from pins. */
  jobTemplates: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const lib = await publishedLibrary();
    const [job] = await db.select({ category: schema.jobs.category }).from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
    if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
    const skills = await db
      .select({ name: schema.skills.name })
      .from(schema.jobTasks)
      .innerJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
      .where(and(eq(schema.jobTasks.jobId, input.jobId), ne(schema.jobTasks.status, "cancelled")));
    const pinned = await pinnedFor(input.jobId);
    const fromLabour = sectionsForLib(lib, skills.map((s) => s.name), job.category);
    return {
      ready: await tablesReady(),
      fromLabour,
      pinned,
      all: sectionsForLib(lib, skills.map((s) => s.name), job.category, pinned),
      options: lib.sections.map((s) => ({ key: s.key, title: s.title, version: s.version })),
    };
  }),

  jobPin: staffOnly
    .input(z.object({ jobId: z.number(), templateKey: z.string().max(80), pinned: z.boolean() }))
    .handler(async ({ input, context }) => {
      await needTables();
      const lib = await publishedLibrary();
      const s = lib.sections.find((x) => x.key === input.templateKey);
      if (input.pinned && !s) throw bad("That template isn't published.");
      if (input.pinned) {
        await db
          .insert(schema.jobSwmsTemplates)
          .values({ jobId: input.jobId, templateKey: input.templateKey, addedByName: context.actor.name })
          .onConflictDoNothing();
      } else {
        await db
          .delete(schema.jobSwmsTemplates)
          .where(and(eq(schema.jobSwmsTemplates.jobId, input.jobId), eq(schema.jobSwmsTemplates.templateKey, input.templateKey)));
      }
      await logChange(
        "job",
        input.jobId,
        input.pinned ? "pinned" : "unpinned",
        `${input.pinned ? "Added" : "Took off"} ${s?.title ?? input.templateKey} ${input.pinned ? "on" : "from"} this job's SWMS.`,
        who(context.actor),
      );
      return { ok: true };
    }),
};
