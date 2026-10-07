import { jobNumberSql } from "../lib/job-ref";
import { z } from "zod";
import { and, asc, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { installerOnly, staffOnly } from "../middleware/auth";
import { putObject, signGet, signPut } from "../lib/s3";
import { addLocalDays, todayLocal } from "../lib/local-date";
import {
  buildSnapshotFrom,
  pinnedFor,
  publishedLibrary,
  reviewDate,
  sdsCatalogue,
  sdsCodesIn,
  sectionsForLib,
  type Library,
  type SwmsSnapshot,
} from "../lib/swms-content";
import { swmsBoard, swmsRequirement } from "../lib/swms";
import { checkSignature, signatureInput, tidySignature, type Signature } from "../lib/signature";
import { renderSwmsPdf } from "../lib/swmsPdf";
import { logChange } from "../lib/swms-admin";
import { ownTaskOrThrow } from "./field";

/**
 * SWMS for Terra Crew, plus the SDS library it attaches.
 *
 * Crew side (installerOnly): load the form for one of MY tasks, sign it.
 * Office side (staffOnly, Admin or Office): turn it on per client, company or job, see who has
 * signed, and keep the safety data sheets current.
 */

const sectionKey = z.string().min(1).max(80);

/** The active sheet per code. Newest upload wins if two are active. */
async function activeDocs(codes?: string[]) {
  const rows = await db
    .select()
    .from(schema.safetyDocs)
    .where(
      and(
        eq(schema.safetyDocs.active, true),
        codes ? inArray(schema.safetyDocs.code, codes.length ? codes : ["-"]) : undefined,
      ),
    )
    .orderBy(desc(schema.safetyDocs.createdAt));
  const out = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    // Only an SDS counts. A product data sheet is kept but never attached as one.
    if (r.kind !== "sds") continue;
    if (!out.has(r.code)) out.set(r.code, r);
  }
  return out;
}

async function catalogueName(code: string) {
  return (await sdsCatalogue()).find((c) => c.code === code)?.product ?? code;
}

async function jobContext(jobId: number, lib?: Library) {
  const [job] = await db
    .select({
      id: schema.jobs.id,
      number: jobNumberSql,
      title: schema.jobs.title,
      category: schema.jobs.category,
      address: schema.sites.address,
      suburb: schema.sites.suburb,
      state: schema.sites.state,
      postcode: schema.sites.postcode,
    })
    .from(schema.jobs)
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const skills = await db
    .select({ name: schema.skills.name })
    .from(schema.jobTasks)
    .innerJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
    .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")));
  const siteAddress = [job.address, job.suburb, [job.state, job.postcode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const autoSections = lib
    ? sectionsForLib(lib, skills.map((s) => s.name), job.category, await pinnedFor(jobId))
    : [];
  return { job, siteAddress, autoSections };
}

/** Ticked ids back out of a stored snapshot, for "same as last time". */
function tickedFrom(content: string) {
  try {
    const snap = JSON.parse(content) as SwmsSnapshot;
    return {
      common: snap.common.filter((i) => i.checked).map((i) => i.id),
      sections: snap.sections.map((s) => ({ key: s.key, checked: s.items.filter((i) => i.checked).map((i) => i.id) })),
    };
  } catch {
    return null;
  }
}

async function recordWithLinks(r: typeof schema.swmsRecords.$inferSelect) {
  const ids = JSON.parse(r.sdsDocIds || "[]") as number[];
  const docs = ids.length
    ? await db.select().from(schema.safetyDocs).where(inArray(schema.safetyDocs.id, ids))
    : [];
  return {
    id: r.id,
    taskId: r.taskId,
    installerId: r.installerId,
    installerName: r.installerName,
    workDate: r.workDate,
    kind: r.kind,
    signedName: r.signedName,
    signedAt: r.signedAt,
    customHazard: r.customHazard,
    pdfUrl: r.pdfKey ? await signGet(r.pdfKey) : null,
    sds: await Promise.all(
      docs.map(async (d) => ({ id: d.id, product: d.product, revision: d.revision, url: await signGet(d.storageKey) })),
    ),
  };
}

export const swms = {
  /* ------------------------------ crew side ----------------------------- */

  /** Everything the phone needs to show the SWMS for one of my tasks. */
  forTask: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    const task = await ownTaskOrThrow(input.taskId, context.installerId);
    const today = todayLocal();
    const lib = await publishedLibrary();
    const [{ job, siteAddress, autoSections }, req, me] = await Promise.all([
      jobContext(task.jobId, lib),
      swmsRequirement([task.jobId]),
      db.select({ name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, context.installerId)),
    ]);

    const mine = await db
      .select()
      .from(schema.swmsRecords)
      .where(and(eq(schema.swmsRecords.jobId, task.jobId), eq(schema.swmsRecords.installerId, context.installerId)))
      .orderBy(desc(schema.swmsRecords.signedAt));
    const todays = mine.find((r) => r.workDate === today) ?? null;
    const earlier = mine.find((r) => r.workDate < today) ?? null;

    const docs = await activeDocs();
    const sds: Record<string, { product: string; revision: string; url: string } | null> = {};
    for (const c of await sdsCatalogue()) {
      const d = docs.get(c.code);
      sds[c.code] = d ? { product: d.product, revision: d.revision, url: await signGet(d.storageKey) } : null;
    }

    return {
      required: req.get(task.jobId)?.required ?? false,
      today,
      signedToday: todays ? await recordWithLinks(todays) : null,
      prefill: {
        installerName: me[0]?.name ?? "",
        jobNumber: job.number,
        jobTitle: job.title,
        siteAddress,
      },
      common: lib.common,
      sections: lib.sections.map((s) => ({ key: s.key, title: s.title, task: s.task, items: s.items })),
      autoSections,
      previous: earlier
        ? {
            id: earlier.id,
            workDate: earlier.workDate,
            customHazard: earlier.customHazard,
            ticked: tickedFrom(earlier.content),
          }
        : null,
      sds,
    };
  }),

  /** Sign it. Builds the PDF, stores it against the job, attaches the right SDS. */
  sign: installerOnly
    .input(
      z.object({
        taskId: z.number(),
        common: z.array(z.string()).max(50),
        sections: z.array(z.object({ key: sectionKey, checked: z.array(z.string()).max(80) })).max(40),
        customHazard: z.string().max(2000).default(""),
        signedName: z.string().trim().min(2, "Type your name.").max(80),
        signature: signatureInput,
        basedOnId: z.number().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const task = await ownTaskOrThrow(input.taskId, context.installerId);
      const problem = checkSignature(input.signature);
      if (problem) throw new ORPCError("BAD_REQUEST", { message: problem });
      const signature: Signature = tidySignature(input.signature);
      const today = todayLocal();
      const signedAt = new Date();

      const [{ job, siteAddress }, me] = await Promise.all([
        jobContext(task.jobId),
        db.select({ name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, context.installerId)),
      ]);
      const installerName = me[0]?.name ?? input.signedName;

      // A re-confirm must point at my own earlier SWMS on this same job.
      let basedOn: { id: number; workDate: string } | null = null;
      if (input.basedOnId) {
        const [b] = await db
          .select({ id: schema.swmsRecords.id, workDate: schema.swmsRecords.workDate })
          .from(schema.swmsRecords)
          .where(
            and(
              eq(schema.swmsRecords.id, input.basedOnId),
              eq(schema.swmsRecords.jobId, task.jobId),
              eq(schema.swmsRecords.installerId, context.installerId),
              lt(schema.swmsRecords.workDate, today),
            ),
          );
        basedOn = b ?? null;
      }

      const snapshot = buildSnapshotFrom(await publishedLibrary(), input.common, input.sections);
      const codes = sdsCodesIn(snapshot);
      const docs = await activeDocs(codes);
      const attached = codes.map((c) => docs.get(c)).filter((d): d is NonNullable<typeof d> => Boolean(d));
      const missing = await Promise.all(codes.filter((c) => !docs.has(c)).map(catalogueName));

      const pdf = await renderSwmsPdf({
        jobNumber: job.number,
        jobTitle: job.title,
        siteAddress,
        workDate: today,
        installerName,
        signedName: input.signedName,
        signedAt,
        kind: basedOn ? "reconfirm" : "full",
        basedOnDate: basedOn?.workDate ?? null,
        snapshot,
        customHazard: input.customHazard,
        sds: attached.map((d) => ({
          product: d.product,
          revision: d.revision,
          issuedOn: d.issuedOn,
          note: d.region !== "AU" ? `${d.region} sheet` : "",
        })),
        missingSds: missing,
        signature,
      });
      const safeName = installerName.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "installer";
      const key = `jobs/${task.jobId}/swms/${today}-${context.installerId}-${Date.now()}.pdf`;
      await putObject(key, pdf, "application/pdf", `SWMS Job ${job.number} ${today} ${safeName}.pdf`);

      const [row] = await db
        .insert(schema.swmsRecords)
        .values({
          jobId: task.jobId,
          taskId: input.taskId,
          installerId: context.installerId,
          installerName,
          workDate: today,
          kind: basedOn ? "reconfirm" : "full",
          basedOnId: basedOn?.id ?? null,
          siteAddress,
          content: JSON.stringify(snapshot),
          customHazard: input.customHazard.trim(),
          signedName: input.signedName,
          signature: JSON.stringify(signature),
          sdsDocIds: JSON.stringify(attached.map((d) => d.id)),
          pdfKey: key,
          signedAt,
        })
        .returning();

      await db.insert(schema.activityLog).values({
        jobId: task.jobId,
        taskId: input.taskId,
        entityType: "task",
        entityId: input.taskId,
        action: "swms_signed",
        detail: `${installerName} signed the SWMS for ${today}${basedOn ? ` (re-confirmed from ${basedOn.workDate})` : ""}`,
        actorName: installerName,
        actorRole: "installer",
      });

      return recordWithLinks(row!);
    }),

  /* ----------------------------- office side ---------------------------- */

  /** The SWMS panel on a job: is it on, why, and every signed record. */
  job: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const req = (await swmsRequirement([input.jobId])).get(input.jobId);
    if (!req) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
    const records = await db
      .select()
      .from(schema.swmsRecords)
      .where(eq(schema.swmsRecords.jobId, input.jobId))
      .orderBy(desc(schema.swmsRecords.workDate), desc(schema.swmsRecords.signedAt));
    const today = todayLocal();
    const board = req.required ? (await swmsBoard(addLocalDays(today, -60), addLocalDays(today, 60))).filter((r) => r.jobId === input.jobId) : [];
    return {
      ...req,
      records: await Promise.all(records.map(recordWithLinks)),
      outstanding: board
        .filter((r) => !r.record && r.date <= today)
        .map((r) => ({ date: r.date, installerName: r.installerName })),
      upcoming: board
        .filter((r) => r.date > today)
        .map((r) => ({ date: r.date, installerName: r.installerName })),
    };
  }),

  /** Null follows the client and company, true or false overrides. */
  setJob: staffOnly
    .input(z.object({ jobId: z.number(), requiresSwms: z.boolean().nullable() }))
    .handler(async ({ input, context }) => {
      await db
        .update(schema.jobs)
        .set({ requiresSwms: input.requiresSwms, updatedAt: new Date() })
        .where(eq(schema.jobs.id, input.jobId));
      await db.insert(schema.activityLog).values({
        jobId: input.jobId,
        entityType: "job",
        entityId: input.jobId,
        action: "swms_setting",
        detail:
          input.requiresSwms === null
            ? "SWMS set to follow the client"
            : input.requiresSwms
              ? "SWMS required on this job"
              : "SWMS not required on this job",
        actorName: context.actor.name,
        actorRole: "admin",
      });
      return (await swmsRequirement([input.jobId])).get(input.jobId)!;
    }),

  setContact: staffOnly
    .input(z.object({ contactId: z.number(), requiresSwms: z.boolean() }))
    .handler(async ({ input }) => {
      await db
        .update(schema.contacts)
        .set({ requiresSwms: input.requiresSwms, updatedAt: new Date() })
        .where(eq(schema.contacts.id, input.contactId));
      return { ok: true };
    }),

  setCompany: staffOnly
    .input(z.object({ companyId: z.number(), requiresSwms: z.boolean() }))
    .handler(async ({ input }) => {
      await db
        .update(schema.companies)
        .set({ requiresSwms: input.requiresSwms, updatedAt: new Date() })
        .where(eq(schema.companies.id, input.companyId));
      return { ok: true };
    }),

  /** Who is booked on a SWMS job each day, and whether they've signed. */
  board: staffOnly
    .input(z.object({ from: z.string().optional(), to: z.string().optional() }).default({}))
    .handler(async ({ input }) => {
      const today = todayLocal();
      const from = input.from ?? addLocalDays(today, -7);
      const to = input.to ?? addLocalDays(today, 14);
      const rows = await swmsBoard(from, to);
      return { today, from, to, rows };
    }),

  /** One signed record with its PDF link, for the board. */
  record: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [r] = await db.select().from(schema.swmsRecords).where(eq(schema.swmsRecords.id, input.id));
    if (!r) throw new ORPCError("NOT_FOUND", { message: "Not found" });
    return recordWithLinks(r);
  }),

  /* ------------------------------ SDS library --------------------------- */

  docs: staffOnly.handler(async () => {
    const rows = await db
      .select()
      .from(schema.safetyDocs)
      .orderBy(asc(schema.safetyDocs.code), desc(schema.safetyDocs.createdAt));
    const docs = await Promise.all(rows.map(async (r) => ({ ...r, url: await signGet(r.storageKey), reviewDue: reviewDate(r) })));
    const today = todayLocal();
    return {
      today,
      catalogue: (await sdsCatalogue()).map((c) => {
        const mine = docs.filter((d) => d.code === c.code);
        const current = mine.find((d) => d.active && d.kind === "sds") ?? null;
        return {
          ...c,
          current,
          expired: Boolean(current?.reviewDue && current.reviewDue < today),
          others: mine.filter((d) => d !== current),
        };
      }),
    };
  }),

  docUploadUrl: staffOnly
    .input(z.object({ filename: z.string().min(1), contentType: z.string().default("application/pdf") }))
    .handler(async ({ input }) => {
      const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-60);
      const key = `safety/sds/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
      return { key, url: await signPut(key, input.contentType) };
    }),

  /** Save an uploaded sheet. A new SDS for a code retires the old one for new SWMS. */
  docSave: staffOnly
    .input(
      z.object({
        code: z.string().min(1).max(80),
        kind: z.enum(["sds", "pds"]).default("sds"),
        revision: z.string().max(80).default(""),
        issuedOn: z.string().max(20).nullable().optional(),
        reviewOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        region: z.enum(["AU", "NZ"]).default("AU"),
        storageKey: z.string().startsWith("safety/sds/"),
        filename: z.string().max(200).default(""),
        sizeBytes: z.number().nullable().optional(),
        notes: z.string().max(500).default(""),
      }),
    )
    .handler(async ({ input, context }) => {
      const entry = (await sdsCatalogue()).find((c) => c.code === input.code);
      if (!entry) throw new ORPCError("BAD_REQUEST", { message: "Unknown product" });
      const product = entry.product;
      const supplier = entry.supplier;
      if (input.kind === "sds") {
        await db
          .update(schema.safetyDocs)
          .set({ active: false, updatedAt: new Date() })
          .where(and(eq(schema.safetyDocs.code, input.code), eq(schema.safetyDocs.kind, "sds")));
      }
      const [row] = await db
        .insert(schema.safetyDocs)
        .values({
          ...input,
          issuedOn: input.issuedOn ?? null,
          reviewOn: input.reviewOn ?? null,
          sizeBytes: input.sizeBytes ?? null,
          product,
          supplier,
          uploadedByName: context.actor.name,
        })
        .returning();
      await logChange(
        "sds",
        row!.id,
        "uploaded",
        `Uploaded ${input.kind === "sds" ? "the SDS" : "a product data sheet"} for ${product}${input.revision ? `, ${input.revision}` : ""}.`,
        { name: context.actor.name, role: context.actor.role },
      );
      return row!;
    }),

  docArchive: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const [d] = await db.select().from(schema.safetyDocs).where(eq(schema.safetyDocs.id, input.id));
    await db.update(schema.safetyDocs).set({ active: false, updatedAt: new Date() }).where(eq(schema.safetyDocs.id, input.id));
    if (d) await logChange("sds", d.id, "retired", `Retired the SDS for ${d.product}. Past SWMS keep their link.`, { name: context.actor.name, role: context.actor.role });
    return { ok: true };
  }),
};
