import { jobNumberSql } from "../lib/job-ref";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { installerOnly, staffOnly } from "../middleware/auth";
import { getObject, putObject, signGet, signPut } from "../lib/s3";
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
import {
  SWMS_FROM,
  TEAM_EMAIL,
  activeSiteChecks,
  answerLabel,
  changedSince,
  checksFor,
  emailsForJob,
  flagsForJob,
  footerTemplates,
  isCleared,
  openBlockingFlags,
  raiseFlag,
  swmsPeople,
  type SiteAnswer,
} from "../lib/swms-checks";
import { TERRA_PRINT } from "../lib/quotePdf";

/**
 * SWMS for Terra Crew, plus the SDS library it attaches.
 *
 * Crew side (installerOnly): load the form for one of MY tasks, sign it.
 * Office side (staffOnly, Admin or Office): turn it on per client, company or job, see who has
 * signed, and keep the safety data sheets current.
 */

const sectionKey = z.string().min(1).max(80);
const answerKey = z.enum(["yes", "no", "unsure", "na"]);

/** What Crew sees when a red card stops the job. */
function blockedMessage(question: string) {
  return `Red card on this job: "${question}". The office has been told. Do not start until they call you.`;
}

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
    gps: r.gpsStatus
      ? { status: r.gpsStatus, lat: r.gpsLat ?? null, lng: r.gpsLng ?? null, accuracy: r.gpsAccuracy ?? null }
      : null,
    siteAnswers: r.siteAnswers ? (JSON.parse(r.siteAnswers) as SiteAnswer[]) : [],
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

    // Stage 3. All optional, so an older app simply ignores them.
    const [checks, flags, changed] = await Promise.all([
      activeSiteChecks(),
      flagsForJob(task.jobId),
      earlier ? changedSince(earlier.content, lib) : Promise.resolve([]),
    ]);

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
            // A newer version since then means a full sign. No ticks means an
            // older app does not offer the quick re-confirm either.
            ticked: changed.length ? null : tickedFrom(earlier.content),
            changed: changed.map((c) => ({
              key: c.key,
              name: c.name,
              from: c.from,
              to: c.to,
              notes: c.notes.map((n) => ({ version: n.version, whatChanged: n.whatChanged })),
            })),
          }
        : null,
      sds,
      /** Every active check. The phone shows the ones for the sections it has picked. */
      siteChecks: checksFor(checks, lib.sections.map((x) => x.key)),
      flags: {
        open: flags
          .filter((f) => !f.clearedAt)
          .map((f) => ({ id: f.id, checkId: f.checkId, question: f.question, answer: f.answer, blocks: f.blocks, installerName: f.installerName, createdAt: f.createdAt })),
        cleared: flags
          .filter((f) => f.clearedAt)
          .map((f) => ({ id: f.id, checkId: f.checkId, answer: f.answer, clearedByName: f.clearedByName ?? "", clearNote: f.clearNote ?? "", clearedAt: f.clearedAt! })),
      },
    };
  }),

  /**
   * Crew tapped an answer that flags a check which stops the job. The red card
   * and the email to team@ happen now, before any signing. Other flagged
   * answers go in with the signing.
   */
  reportCheck: installerOnly
    .input(z.object({ taskId: z.number(), checkId: z.number(), answer: answerKey }))
    .handler(async ({ input, context }) => {
      const task = await ownTaskOrThrow(input.taskId, context.installerId);
      const check = (await activeSiteChecks()).find((c) => c.id === input.checkId);
      if (!check) throw new ORPCError("NOT_FOUND", { message: "That site check is no longer in use. Pull down to refresh." });
      if (!check.answers.includes(input.answer)) throw new ORPCError("BAD_REQUEST", { message: "That answer is not one of the choices." });
      if (!check.flagOn.includes(input.answer)) return { flagged: false, blocks: check.blocks, cleared: false, flagId: null };
      if (!check.blocks) return { flagged: true, blocks: false, cleared: false, flagId: null };
      if (isCleared(await flagsForJob(task.jobId), check.id, input.answer)) {
        return { flagged: true, blocks: true, cleared: true, flagId: null };
      }
      const [{ job, siteAddress }, me] = await Promise.all([
        jobContext(task.jobId),
        db.select({ name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, context.installerId)),
      ]);
      const { flag } = await raiseFlag({
        jobId: task.jobId,
        taskId: input.taskId,
        recordId: null,
        installerId: context.installerId,
        installerName: me[0]?.name ?? "",
        check,
        answer: input.answer,
        job: { number: job.number, title: job.title, siteAddress },
      });
      return { flagged: true, blocks: true, cleared: false, flagId: flag?.id ?? null };
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
        /** Stage 3. Left out by older apps. */
        siteAnswers: z.array(z.object({ checkId: z.number(), answer: answerKey })).max(60).optional(),
        gps: z
          .object({
            status: z.enum(["ok", "denied", "timeout", "unavailable"]),
            lat: z.number().min(-90).max(90).nullable(),
            lng: z.number().min(-180).max(180).nullable(),
            accuracy: z.number().min(0).max(1_000_000).nullable(),
          })
          .nullable()
          .optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const task = await ownTaskOrThrow(input.taskId, context.installerId);
      const problem = checkSignature(input.signature);
      if (problem) throw new ORPCError("BAD_REQUEST", { message: problem });
      const signature: Signature = tidySignature(input.signature);
      const today = todayLocal();
      const signedAt = new Date();

      const [{ job, siteAddress }, me, people] = await Promise.all([
        jobContext(task.jobId),
        db.select({ name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, context.installerId)),
        swmsPeople(task.jobId),
      ]);
      const installerName = me[0]?.name ?? input.signedName;

      // A red card that stops the job: nobody signs until Office clears it.
      const stopped = await openBlockingFlags(task.jobId);
      if (stopped.length) {
        throw new ORPCError("PRECONDITION_FAILED", { message: blockedMessage(stopped[0]!.question), data: { swmsBlocked: true } });
      }

      const lib = await publishedLibrary();

      // A re-confirm must point at my own earlier SWMS on this same job.
      let basedOn: { id: number; workDate: string; content: string } | null = null;
      if (input.basedOnId) {
        const [b] = await db
          .select({ id: schema.swmsRecords.id, workDate: schema.swmsRecords.workDate, content: schema.swmsRecords.content })
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
        if (basedOn && (await changedSince(basedOn.content, lib)).length) {
          throw new ORPCError("BAD_REQUEST", {
            message: "The SWMS has changed since you last signed. Go back, read what changed, and sign it in full.",
          });
        }
      }

      // Site checks. An older app sends none, and signs as before.
      const checks = checksFor(await activeSiteChecks(), input.sections.map((x) => x.key));
      const flags = input.siteAnswers ? await flagsForJob(task.jobId) : [];
      const answers: SiteAnswer[] = [];
      if (input.siteAnswers) {
        const given = new Map(input.siteAnswers.map((a) => [a.checkId, a.answer]));
        for (const c of checks) {
          const a = given.get(c.id);
          if (!a) throw new ORPCError("BAD_REQUEST", { message: `Answer the site check: "${c.question}"` });
          if (!c.answers.includes(a)) throw new ORPCError("BAD_REQUEST", { message: `"${answerLabel(a)}" is not an answer to "${c.question}".` });
          const flagged = c.flagOn.includes(a);
          answers.push({ checkId: c.id, question: c.question, answer: a, flagged, blocks: c.blocks, cleared: flagged && isCleared(flags, c.id, a) });
        }
        // The phone reports these as they are tapped. If it did not, do it now and stop.
        const stopper = answers.find((a) => a.flagged && a.blocks && !a.cleared);
        if (stopper) {
          await raiseFlag({
            jobId: task.jobId,
            taskId: input.taskId,
            recordId: null,
            installerId: context.installerId,
            installerName,
            check: checks.find((c) => c.id === stopper.checkId)!,
            answer: stopper.answer,
            job: { number: job.number, title: job.title, siteAddress },
          });
          throw new ORPCError("PRECONDITION_FAILED", { message: blockedMessage(stopper.question), data: { swmsBlocked: true } });
        }
      }
      const gps = input.gps
        ? input.gps.status === "ok" && input.gps.lat !== null && input.gps.lng !== null
          ? input.gps
          : { status: input.gps.status, lat: null, lng: null, accuracy: null }
        : { status: "not_sent", lat: null, lng: null, accuracy: null };

      const snapshot = buildSnapshotFrom(lib, input.common, input.sections);
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
        builder: people.builder,
        supervisor: people.supervisor,
        gps,
        siteAnswers: answers,
        templates: await footerTemplates(snapshot),
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
          gpsLat: gps.lat,
          gpsLng: gps.lng,
          gpsAccuracy: gps.accuracy,
          gpsStatus: gps.status,
          siteAnswers: input.siteAnswers ? JSON.stringify(answers) : null,
        })
        .returning();

      // Flagged answers that do not stop the job: red card and email, once.
      for (const a of answers.filter((x) => x.flagged && !x.blocks && !x.cleared)) {
        await raiseFlag({
          jobId: task.jobId,
          taskId: input.taskId,
          recordId: row!.id,
          installerId: context.installerId,
          installerName,
          check: checks.find((c) => c.id === a.checkId)!,
          answer: a.answer,
          job: { number: job.number, title: job.title, siteAddress },
        });
      }

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
    const [flags, emails] = await Promise.all([flagsForJob(input.jobId), emailsForJob(input.jobId)]);
    return {
      ...req,
      flags,
      emails,
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

  /** Red cards on a job, open first. */
  flags: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => flagsForJob(input.jobId)),

  /** Clear a red card. Needs a note. Who and when are kept, nothing is deleted. */
  clearFlag: staffOnly
    .input(z.object({ id: z.number(), note: z.string().trim().min(3, "Write a short note on what was sorted.").max(1000) }))
    .handler(async ({ input, context }) => {
      const [f] = await db.select().from(schema.swmsFlags).where(eq(schema.swmsFlags.id, input.id));
      if (!f) throw new ORPCError("NOT_FOUND", { message: "Red card not found" });
      if (f.clearedAt) throw new ORPCError("BAD_REQUEST", { message: `Already cleared by ${f.clearedByName || "someone"}.` });
      await db
        .update(schema.swmsFlags)
        .set({ clearedAt: new Date(), clearedByName: context.actor.name, clearNote: input.note })
        .where(and(eq(schema.swmsFlags.id, f.id), isNull(schema.swmsFlags.clearedAt)));
      await db.insert(schema.activityLog).values({
        jobId: f.jobId,
        entityType: "job",
        entityId: f.jobId,
        action: "swms_flag_cleared",
        detail: `Cleared the SWMS red card "${f.question}" (${answerLabel(f.answer)}): ${input.note}`,
        actorName: context.actor.name,
        actorRole: context.actor.role === "admin" ? "admin" : "office",
      });
      return { ok: true };
    }),

  /** Who the SWMS email goes to: builder contact, then supervisor, then the builder company. */
  emailPeople: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => swmsPeople(input.jobId)),

  /** Office emails a signed SWMS PDF. Every address is logged on the job. */
  emailRecord: staffOnly
    .input(
      z.object({
        recordId: z.number(),
        to: z.array(z.string().trim().toLowerCase().email("Check the email address.")).min(1, "Add an email address.").max(10),
        message: z.string().max(2000).default(""),
      }),
    )
    .handler(async ({ input, context }) => {
      const [r] = await db.select().from(schema.swmsRecords).where(eq(schema.swmsRecords.id, input.recordId));
      if (!r) throw new ORPCError("NOT_FOUND", { message: "SWMS not found" });
      if (!r.pdfKey) throw new ORPCError("BAD_REQUEST", { message: "This SWMS has no PDF." });
      const { job } = await jobContext(r.jobId);
      const pdf = await getObject(r.pdfKey);
      const safeName = r.installerName.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "installer";
      const filename = `SWMS Job ${job.number} ${r.workDate} ${safeName}.pdf`;
      const subject = `SWMS: Job #${job.number}${r.siteAddress ? `, ${r.siteAddress}` : ""}, ${r.workDate}`;
      const note = input.message.trim();
      const text = [
        "Hi,",
        "",
        `Attached is the signed Safe Work Method Statement for ${r.installerName} on ${r.workDate}${r.siteAddress ? ` at ${r.siteAddress}` : ""} (Job #${job.number}).`,
        ...(note ? ["", note] : []),
        "",
        "Thanks,",
        context.actor.name,
        "Terra Flooring",
        TERRA_PRINT.phones,
      ].join("\n");
      const esc = (x: string) => x.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
      const html = text
        .split("\n\n")
        .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
        .join("");
      const { sendEmail } = await import("../lib/email");
      const results: Array<{ to: string; ok: boolean; error: string | null }> = [];
      for (const to of new Set(input.to)) {
        let ok = false;
        let error: string | null = null;
        try {
          const out = await sendEmail({
            to,
            from: SWMS_FROM,
            replyTo: TEAM_EMAIL,
            subject,
            text,
            html,
            attachments: [{ filename, content: pdf.toString("base64") }],
          });
          ok = out.ok;
          if (!out.ok) error = out.reason;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        await db.insert(schema.swmsEmails).values({
          jobId: r.jobId,
          recordId: r.id,
          toEmail: to,
          sentByName: context.actor.name,
          ok,
          error,
        });
        results.push({ to, ok, error });
      }
      const sent = results.filter((x) => x.ok).map((x) => x.to);
      const failed = results.filter((x) => !x.ok).map((x) => x.to);
      await db.insert(schema.activityLog).values({
        jobId: r.jobId,
        entityType: "job",
        entityId: r.jobId,
        action: "swms_emailed",
        detail: `Emailed the SWMS for ${r.installerName}, ${r.workDate}${sent.length ? ` to ${sent.join(", ")}` : ""}${failed.length ? `. Not sent to ${failed.join(", ")}` : ""}`,
        actorName: context.actor.name,
        actorRole: context.actor.role === "admin" ? "admin" : "office",
      });
      return { results };
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
