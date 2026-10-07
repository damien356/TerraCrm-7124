import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { parseJson, type Library, type SwmsSnapshot } from "./swms-content";

/* ---------------------------------------------------------------------------
 * SWMS Stage 3: site checks, red cards, "what changed", and who the builder is.
 *
 * Damien, 8 Oct:
 *   - A flagged answer on a check that blocks stops Crew signing at all until
 *     Office or Admin clears the red card. Office is emailed straight away.
 *   - A flagged answer on any other check still makes a red card and emails
 *     team@, but Crew can sign and start.
 *   - Clearing keeps the row and logs who, when and the note.
 *
 * Every read of the new tables falls back to "nothing" if the tables are not
 * there yet, so the phone never loses its SWMS over a missing table.
 * ------------------------------------------------------------------------- */

export const TEAM_EMAIL = "team@terraflooring.com.au";
export const SWMS_FROM = "Terra Flooring <team@terraflooring.com.au>";
export const OPS_URL = (process.env.MAIL_OAUTH_BASE ?? "https://ops.terraflooring.com.au").replace(/\/+$/, "");

export const ANSWER_LABEL: Record<string, string> = { yes: "Yes", no: "No", unsure: "Unsure", na: "N/A" };
export const answerLabel = (a: string) => ANSWER_LABEL[a] ?? a;

export type SiteCheck = {
  id: number;
  question: string;
  answers: string[];
  flagOn: string[];
  blocks: boolean;
  appliesAll: boolean;
  templateKeys: string[];
};

export type SiteAnswer = {
  checkId: number;
  question: string;
  answer: string;
  flagged: boolean;
  blocks: boolean;
  /** Flagged before, and Office cleared it on this job. */
  cleared: boolean;
};

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Active checks, in order. Empty before the Stage 2 tables exist. */
export async function activeSiteChecks(): Promise<SiteCheck[]> {
  return safe(async () => {
    const rows = await db
      .select()
      .from(schema.swmsSiteChecks)
      .where(isNull(schema.swmsSiteChecks.archivedAt))
      .orderBy(asc(schema.swmsSiteChecks.sortOrder), asc(schema.swmsSiteChecks.id));
    return rows.map((c) => ({
      id: c.id,
      question: c.question,
      answers: parseJson<string[]>(c.answers, ["yes", "no"]),
      flagOn: parseJson<string[]>(c.flagOn, []),
      blocks: c.blocks,
      appliesAll: c.appliesAll,
      templateKeys: parseJson<string[]>(c.templateKeys, []),
    }));
  }, []);
}

/** The checks that show for these sections. */
export function checksFor(checks: SiteCheck[], sectionKeys: string[]) {
  const keys = new Set(sectionKeys);
  return checks.filter((c) => c.appliesAll || c.templateKeys.some((k) => keys.has(k)));
}

export type FlagRow = typeof schema.swmsFlags.$inferSelect;

export async function flagsForJob(jobId: number): Promise<FlagRow[]> {
  return safe(
    () =>
      db
        .select()
        .from(schema.swmsFlags)
        .where(eq(schema.swmsFlags.jobId, jobId))
        .orderBy(sql`${schema.swmsFlags.clearedAt} is not null`, sql`${schema.swmsFlags.createdAt} desc`),
    [],
  );
}

/** Open red cards that stop the job. */
export async function openBlockingFlags(jobId: number): Promise<FlagRow[]> {
  return safe(
    () =>
      db
        .select()
        .from(schema.swmsFlags)
        .where(and(eq(schema.swmsFlags.jobId, jobId), eq(schema.swmsFlags.blocks, true), isNull(schema.swmsFlags.clearedAt))),
    [],
  );
}

/** Has Office already cleared this answer to this check on this job? Then it does not flag again. */
export function isCleared(flags: FlagRow[], checkId: number, answer: string) {
  return flags.some((f) => f.checkId === checkId && f.answer === answer && f.clearedAt);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function stamp(d: Date) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** The email to team@ for a new red card. A failed send never stops the flag. */
async function emailTeam(flag: FlagRow, job: { number: string | number; title: string; siteAddress: string }) {
  try {
    const { sendEmail } = await import("./email");
    const url = `${OPS_URL}/jobs/${flag.jobId}`;
    const what = flag.blocks
      ? "This stops the job. Crew cannot sign the SWMS or start until someone clears the red card in Ops."
      : "Crew can still sign and start. Check it and clear the red card in Ops.";
    const lines = [
      `Job #${job.number}${job.title ? `, ${job.title}` : ""}`,
      job.siteAddress ? `Site: ${job.siteAddress}` : "",
      `Question: ${flag.question}`,
      `Answer: ${answerLabel(flag.answer)}`,
      `From: ${flag.installerName || "Crew"}, ${stamp(flag.createdAt)}`,
    ].filter(Boolean);
    const out = await sendEmail({
      to: TEAM_EMAIL,
      from: SWMS_FROM,
      replyTo: TEAM_EMAIL,
      subject: `${flag.blocks ? "SWMS red card, job stopped" : "SWMS red card"}: Job #${job.number}`,
      text: `${lines.join("\n")}\n\n${what}\n\nCall the crew.\n${url}`,
      html: `<p>${lines.map(esc).join("<br>")}</p><p><b>${esc(what)}</b></p><p>Call the crew.</p><p><a href="${esc(url)}">${esc(url)}</a></p>`,
    });
    if (out.ok) await db.update(schema.swmsFlags).set({ emailed: true }).where(eq(schema.swmsFlags.id, flag.id));
    else console.error("swms flag email not sent", out.reason);
  } catch (e) {
    console.error("swms flag email failed", e);
  }
}

/**
 * Raise a red card, once. If this check already has an open card on the job,
 * that one stands and nobody is emailed twice. If Office already cleared this
 * same answer on this job, nothing new is raised.
 */
export async function raiseFlag(args: {
  jobId: number;
  taskId: number | null;
  recordId: number | null;
  installerId: number | null;
  installerName: string;
  check: SiteCheck;
  answer: string;
  job: { number: string | number; title: string; siteAddress: string };
}): Promise<{ flag: FlagRow | null; created: boolean }> {
  const existing = await db
    .select()
    .from(schema.swmsFlags)
    .where(and(eq(schema.swmsFlags.jobId, args.jobId), eq(schema.swmsFlags.checkId, args.check.id)));
  if (isCleared(existing, args.check.id, args.answer)) return { flag: null, created: false };
  const open = existing.find((f) => !f.clearedAt);
  if (open) {
    if (args.recordId && !open.recordId) {
      await db.update(schema.swmsFlags).set({ recordId: args.recordId }).where(eq(schema.swmsFlags.id, open.id));
    }
    return { flag: open, created: false };
  }
  const [flag] = await db
    .insert(schema.swmsFlags)
    .values({
      jobId: args.jobId,
      taskId: args.taskId,
      recordId: args.recordId,
      installerId: args.installerId,
      installerName: args.installerName,
      checkId: args.check.id,
      question: args.check.question,
      answer: args.answer,
      blocks: args.check.blocks,
    })
    .returning();
  await db.insert(schema.activityLog).values({
    jobId: args.jobId,
    taskId: args.taskId,
    entityType: "job",
    entityId: args.jobId,
    action: "swms_flag",
    detail: `SWMS red card from ${args.installerName || "Crew"}: "${args.check.question}" answered ${answerLabel(args.answer)}${args.check.blocks ? ". Job stopped until cleared." : "."}`,
    actorName: args.installerName || "Crew",
    actorRole: "installer",
  });
  await emailTeam(flag!, args.job);
  return { flag: flag!, created: true };
}

/* ---------------------------- what changed ---------------------------- */

export type TemplateChange = {
  key: string;
  name: string;
  from: number;
  to: number;
  notes: Array<{ version: number; whatChanged: string; publishedAt: Date }>;
};

/** Template key and version pairs in a signed snapshot. Before Stage 2 there was no version: that is version 1. */
function signedVersions(snap: SwmsSnapshot): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of snap.commonFrom ?? [{ key: "every_job", name: "Every job", version: null }]) out.set(c.key, c.version ?? 1);
  for (const s of snap.sections) out.set(s.key, s.version ?? 1);
  return out;
}

/**
 * Templates on a signed SWMS that have a newer published version now. Any
 * change means the next signing is a full one, with the notes shown first.
 * A template that is not on that SWMS does not count.
 */
export async function changedSince(content: string, lib: Library): Promise<TemplateChange[]> {
  if (lib.source !== "db") return [];
  const snap = parseJson<SwmsSnapshot | null>(content, null);
  if (!snap) return [];
  const signed = signedVersions(snap);
  const now = new Map<string, { name: string; version: number; templateId: number | null }>();
  for (const c of lib.commonFrom) if (c.version) now.set(c.key, { name: c.name, version: c.version, templateId: null });
  for (const s of lib.sections) if (s.version) now.set(s.key, { name: s.title, version: s.version, templateId: s.templateId });
  const changed: TemplateChange[] = [];
  for (const [key, from] of signed) {
    const cur = now.get(key);
    if (cur && cur.version > from) changed.push({ key, name: cur.name, from, to: cur.version, notes: [] });
  }
  if (!changed.length) return [];
  const rows = await safe(
    () =>
      db
        .select({
          key: schema.swmsTemplates.key,
          version: schema.swmsTemplateVersions.version,
          whatChanged: schema.swmsTemplateVersions.whatChanged,
          publishedAt: schema.swmsTemplateVersions.publishedAt,
        })
        .from(schema.swmsTemplateVersions)
        .innerJoin(schema.swmsTemplates, eq(schema.swmsTemplates.id, schema.swmsTemplateVersions.templateId))
        .where(inArray(schema.swmsTemplates.key, changed.map((c) => c.key)))
        .orderBy(asc(schema.swmsTemplateVersions.version)),
    [],
  );
  for (const c of changed) {
    c.notes = rows
      .filter((r) => r.key === c.key && r.version > c.from && r.version <= c.to)
      .map((r) => ({ version: r.version, whatChanged: r.whatChanged, publishedAt: r.publishedAt }));
  }
  return changed;
}

/* ------------------------------ PDF footer ----------------------------- */

export type FooterTemplate = {
  name: string;
  version: number | null;
  publishedAt: Date | null;
  reviewedByName: string;
  reviewedByQualification: string;
  reviewedOn: string | null;
};

/** The exact versions a snapshot was signed against, with publish and review details. */
export async function footerTemplates(snap: SwmsSnapshot): Promise<FooterTemplate[]> {
  const wanted: Array<{ key: string; name: string; version: number | null }> = [
    ...(snap.commonFrom ?? [{ key: "every_job", name: "Every job", version: null }]),
    ...snap.sections.map((s) => ({ key: s.key, name: s.title, version: s.version ?? null })),
  ];
  const keys = wanted.filter((w) => w.version).map((w) => w.key);
  const rows = keys.length
    ? await safe(
        () =>
          db
            .select({
              key: schema.swmsTemplates.key,
              version: schema.swmsTemplateVersions.version,
              publishedAt: schema.swmsTemplateVersions.publishedAt,
              reviewedByName: schema.swmsTemplateVersions.reviewedByName,
              reviewedByQualification: schema.swmsTemplateVersions.reviewedByQualification,
              reviewedOn: schema.swmsTemplateVersions.reviewedOn,
            })
            .from(schema.swmsTemplateVersions)
            .innerJoin(schema.swmsTemplates, eq(schema.swmsTemplates.id, schema.swmsTemplateVersions.templateId))
            .where(inArray(schema.swmsTemplates.key, keys)),
        [],
      )
    : [];
  return wanted.map((w) => {
    const r = rows.find((x) => x.key === w.key && x.version === w.version);
    return {
      name: w.name,
      version: w.version,
      publishedAt: r?.publishedAt ?? null,
      reviewedByName: r?.reviewedByName ?? "",
      reviewedByQualification: r?.reviewedByQualification ?? "",
      reviewedOn: r?.reviewedOn ?? null,
    };
  });
}

/* --------------------------- builder and people --------------------------- */

export type SwmsRecipient = { email: string; name: string; why: string };

/**
 * The builder company, the site supervisor, and who the SWMS goes to.
 * Prefill order (Damien's plan): the job's builder contact, then the
 * supervisor, then the builder company's own email.
 */
export async function swmsPeople(jobId: number) {
  const [job] = await db
    .select({ companyId: schema.jobs.companyId, company: schema.companies.name, companyEmail: schema.companies.email })
    .from(schema.jobs)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
    .where(eq(schema.jobs.id, jobId));
  const people = await db
    .select({
      tags: schema.jobContacts.tags,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
      email: schema.contacts.email,
      mobile: schema.contacts.mobile,
    })
    .from(schema.jobContacts)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.jobContacts.contactId))
    .where(eq(schema.jobContacts.jobId, jobId))
    .orderBy(asc(schema.jobContacts.id));
  const withTag = (tag: string) =>
    people
      .filter((p) => parseJson<string[]>(p.tags, []).includes(tag))
      .map((p) => ({ name: [p.firstName, p.lastName].filter(Boolean).join(" "), email: p.email?.trim() || "", mobile: p.mobile ?? "" }));
  const builderContacts = withTag("builder_contact");
  const supervisors = withTag("supervisor");
  const supervisor = supervisors[0] ?? null;

  const candidates: SwmsRecipient[] = [];
  const add = (email: string, name: string, why: string) => {
    const e = email.trim().toLowerCase();
    if (!e || !e.includes("@") || candidates.some((c) => c.email === e)) return;
    candidates.push({ email: e, name, why });
  };
  for (const b of builderContacts) add(b.email, b.name, "Builder contact");
  for (const s of supervisors) add(s.email, s.name, "Supervisor");
  if (job?.companyEmail) add(job.companyEmail, job.company ?? "", "Builder company");

  const tier = builderContacts.some((b) => b.email)
    ? "Builder contact"
    : supervisors.some((s) => s.email)
      ? "Supervisor"
      : "Builder company";
  return {
    builder: job?.company ?? null,
    supervisor: supervisor ? { name: supervisor.name, mobile: supervisor.mobile } : null,
    candidates,
    prefill: candidates.filter((c) => c.why === tier).map((c) => c.email),
  };
}

/** Sends logged on a job, newest first. */
export async function emailsForJob(jobId: number) {
  return safe(
    () =>
      db
        .select()
        .from(schema.swmsEmails)
        .where(eq(schema.swmsEmails.jobId, jobId))
        .orderBy(sql`${schema.swmsEmails.sentAt} desc`),
    [],
  );
}
