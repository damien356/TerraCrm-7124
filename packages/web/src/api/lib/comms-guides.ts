import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { CARE_SIGNOFF, applyConditions, careBodyText } from "./care-render";
import { CARE_TEMPLATES, CARE_TEMPLATE_MAP, HAND_GUIDE_SIGNOFF, HAND_GUIDE_TEMPLATES } from "./care-templates";
import { blockFor, commsEvent, confirmLine, jobComms, type JobCommsContext, type JobPerson } from "./comms-people";
import { ensureForJob } from "./conversations";
import { supplyOnlyOf } from "./delivery";
import { sendJobEmail } from "./job-mail";

/* ---------------------------------------------------------------------------
 * CARE GUIDES SENT BY HAND (Damien, 31 Oct).
 *
 *   - Never automatic. The office picks one or more guides and one person.
 *   - The person must be on the job and allowed to get it: on a builder type
 *     job the supervisor or job contact, the property manager, or a homeowner
 *     the builder has OK'd. Never the company's email as a fallback.
 *   - One email per guide, on the job's conversation. "Sent" only once the mail
 *     service took it. A failure shows the reason and Retry.
 *   - A guide already sent on this job asks "Already sent on X. Send again?"
 *     first. Each press of Send has its own key, so a double click sends once.
 * ------------------------------------------------------------------------- */

/** Guides that can go by hand: every care email except the seasonal (H) ones, plus the hand only guides (D1 timber deck). */
export const HAND_SEND_CODES = [...CARE_TEMPLATES.filter((t) => !/^H\d/.test(t.code)).map((t) => t.code), ...HAND_GUIDE_TEMPLATES.map((t) => t.code)];

const INSTALL_WORDS = /\b(install(ed|ing|er|ers|ation)?|we left|after we|our (crew|team|installers?))\b/i;
/** A send still "sending" after this long crashed part way. Shown as failed, checked by a person before Retry. */
const STUCK_MS = 10 * 60_000;

const auDay = (d: Date) => d.toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short", year: "numeric" });

export class GuideError extends Error {}

export type GuideGroup = "Indoor flooring" | "Exterior timber decking";

export function guideList() {
  return HAND_SEND_CODES.map((c) => CARE_TEMPLATE_MAP.get(c)!).map((t) => {
    const handOnly = HAND_GUIDE_TEMPLATES.some((h) => h.code === t.code);
    /* Decking is its own group, kept apart from the indoor floor guides (Damien, 31 Oct). */
    return { code: t.code, title: t.title, audience: t.audience, handOnly, group: (t.code.startsWith("D") ? "Exterior timber decking" : "Indoor flooring") as GuideGroup };
  });
}

const titleOf = (code: string) => CARE_TEMPLATE_MAP.get(code)?.title ?? code;

/** The guide text for one person, signature included. */
export function guideText(code: string, first: string) {
  const t = CARE_TEMPLATE_MAP.get(code);
  if (!t || !HAND_SEND_CODES.includes(code)) throw new GuideError("Pick a care guide from the list.");
  const body = careBodyText(applyConditions(t.body, { fibre: "", pile: "" }).split("{{first_name}}").join(first || "there"));
  const signoff = HAND_GUIDE_SIGNOFF[code] ?? [...CARE_SIGNOFF];
  return { subject: t.subject, body: `${body}\n\n${signoff.join("\n")}` };
}

function personOrThrow(ctx: JobCommsContext, contactId: number): JobPerson {
  const p = ctx.people.find((x) => x.contactId === contactId);
  if (!p) throw new GuideError("That person is not on this job. Add them in People first.");
  return p;
}

/** Last sent of each guide on this job, for "Already sent on X". */
async function lastSentByCode(jobId: number, codes: string[]) {
  if (!codes.length) return new Map<string, { at: Date; to: string }>();
  const rows = await db
    .select()
    .from(schema.careGuideSends)
    .where(and(eq(schema.careGuideSends.jobId, jobId), eq(schema.careGuideSends.status, "sent"), inArray(schema.careGuideSends.code, codes)))
    .orderBy(desc(schema.careGuideSends.id));
  const out = new Map<string, { at: Date; to: string }>();
  for (const r of rows) if (!out.has(r.code)) out.set(r.code, { at: r.updatedAt, to: r.toAddress });
  return out;
}

/** Drafts for the picked guides and person, ready to read and edit. Nothing is sent. */
export async function guideDrafts(jobId: number, contactId: number, codes: string[]) {
  const ctx = await jobComms(jobId);
  if (!ctx) throw new GuideError("Job not found.");
  const p = personOrThrow(ctx, contactId);
  const block = await blockFor(ctx, p, "care_guide", "email");
  const { supplyOnly } = await supplyOnlyOf(jobId);
  const last = await lastSentByCode(jobId, codes);
  return {
    confirm: confirmLine(p, p.email || "(no email)"),
    to: p.email,
    block,
    supplyOnly,
    drafts: codes.map((code) => {
      const { subject, body } = guideText(code, p.firstName);
      const flagged = supplyOnly
        ? body
            .split(/\n+/)
            .flatMap((s) => s.split(/(?<=[.!?])\s+/))
            .filter((s) => INSTALL_WORDS.test(s))
            .map((s) => s.trim())
            .slice(0, 8)
        : [];
      const had = last.get(code);
      return {
        code,
        title: titleOf(code),
        subject,
        body,
        flagged,
        alreadySent: had ? { at: had.at.getTime(), to: had.to, text: `Already sent on ${auDay(had.at)} to ${had.to}. Send again?` } : null,
      };
    }),
  };
}

export type GuideSendItem = { code: string; subject: string; body: string };
export type GuideSendOutcome = { code: string; title: string; outcome: "sent" | "failed" | "already"; detail: string; id: number | null };

async function sendOne(rowId: number, ctx: JobCommsContext, p: JobPerson, it: GuideSendItem, byName: string, profileId: number | null): Promise<GuideSendOutcome> {
  try {
    const conv = await ensureForJob(ctx.job.id);
    const msg = await sendJobEmail({
      conv,
      jobId: ctx.job.id,
      to: p.email,
      subject: it.subject,
      text: it.body,
      audience: "customer",
      contactId: p.contactId,
      authorName: byName,
      authorProfileId: profileId,
    });
    const messageId = msg.message.id;
    await db.update(schema.careGuideSends).set({ status: "sent", messageId, error: "", updatedAt: new Date() }).where(eq(schema.careGuideSends.id, rowId));
    await commsEvent({ jobId: ctx.job.id, kind: "care_guide", refId: rowId, event: "sent", detail: `${titleOf(it.code)} sent to ${confirmLine(p, p.email)}.`, channel: "email", toAddress: p.email, messageId, byName });
    return { code: it.code, title: titleOf(it.code), outcome: "sent", detail: `Sent to ${p.email}.`, id: rowId };
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).slice(0, 300) || "The mail service did not take it.";
    await db.update(schema.careGuideSends).set({ status: "failed", error: why, updatedAt: new Date() }).where(eq(schema.careGuideSends.id, rowId));
    await commsEvent({ jobId: ctx.job.id, kind: "care_guide", refId: rowId, event: "failed", detail: `${titleOf(it.code)} to ${p.email} failed: ${why}`, channel: "email", toAddress: p.email, byName });
    return { code: it.code, title: titleOf(it.code), outcome: "failed", detail: why, id: rowId };
  }
}

/**
 * Sends the picked guides to one person, one email each. A guide sent before on
 * this job only goes if its code is in `sendAgain`.
 */
export async function sendGuides(a: { jobId: number; contactId: number; items: GuideSendItem[]; sendAgain: string[]; requestKey: string; byName: string; profileId: number | null }) {
  const ctx = await jobComms(a.jobId);
  if (!ctx) throw new GuideError("Job not found.");
  const p = personOrThrow(ctx, a.contactId);
  const block = await blockFor(ctx, p, "care_guide", "email");
  if (block) throw new GuideError(block);
  const codes = [...new Set(a.items.map((i) => i.code))];
  if (!codes.length) throw new GuideError("Pick at least one guide.");
  if (codes.length !== a.items.length) throw new GuideError("Each guide can only be picked once.");
  for (const it of a.items) {
    if (!HAND_SEND_CODES.includes(it.code)) throw new GuideError("Pick a care guide from the list.");
    if (!it.subject.trim() || !it.body.trim()) throw new GuideError(`${titleOf(it.code)} needs a subject and a message.`);
  }
  const last = await lastSentByCode(a.jobId, codes);
  const again = codes.filter((c) => last.has(c) && !a.sendAgain.includes(c));
  if (again.length) {
    const c = again[0]!;
    throw new GuideError(`${titleOf(c)}: already sent on ${auDay(last.get(c)!.at)} to ${last.get(c)!.to}. Tick "Send again" to send it again.`);
  }

  const out: GuideSendOutcome[] = [];
  for (const it of a.items) {
    const now = new Date();
    /* The claim. The same press twice (double click, a retry of the request) finds the row and sends nothing. */
    const claimed = await db
      .insert(schema.careGuideSends)
      .values({ jobId: a.jobId, contactId: p.contactId, code: it.code, toAddress: p.email, role: p.mainRole, subject: it.subject.trim(), body: it.body.trim(), status: "sending", requestKey: a.requestKey, byName: a.byName, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning({ id: schema.careGuideSends.id });
    if (!claimed.length) {
      out.push({ code: it.code, title: titleOf(it.code), outcome: "already", detail: "Already being sent from this press of Send.", id: null });
      continue;
    }
    out.push(await sendOne(claimed[0]!.id, ctx, p, { ...it, subject: it.subject.trim(), body: it.body.trim() }, a.byName, a.profileId));
  }
  return out;
}

/** Sends a failed guide again, exactly as it was, to the same person. Their details are checked again first. */
export async function retryGuide(id: number, byName: string, profileId: number | null) {
  const [r] = await db.select().from(schema.careGuideSends).where(eq(schema.careGuideSends.id, id));
  if (!r) throw new GuideError("That send is gone.");
  const stuck = r.status === "sending" && Date.now() - r.updatedAt.getTime() > STUCK_MS;
  if (r.status !== "failed" && !stuck) throw new GuideError(r.status === "sent" ? "That one was sent." : "That one is still sending.");
  if (!r.contactId) throw new GuideError("The person's card is gone. Send it again from the guide picker.");
  const ctx = await jobComms(r.jobId);
  if (!ctx) throw new GuideError("Job not found.");
  const p = personOrThrow(ctx, r.contactId);
  const block = await blockFor(ctx, p, "care_guide", "email");
  if (block) throw new GuideError(block);
  if (p.email !== r.toAddress.toLowerCase()) throw new GuideError(`${p.name}'s email changed to ${p.email}. Send it again from the guide picker so you can check it.`);
  /* Claim the retry: only one press moves it from failed to sending. */
  const claimed = await db
    .update(schema.careGuideSends)
    .set({ status: "sending", error: "", byName, updatedAt: new Date() })
    .where(and(eq(schema.careGuideSends.id, id), eq(schema.careGuideSends.status, r.status), lte(schema.careGuideSends.updatedAt, r.updatedAt)))
    .returning({ id: schema.careGuideSends.id });
  if (!claimed.length) throw new GuideError("Someone else just pressed Retry.");
  return sendOne(id, ctx, p, { code: r.code, subject: r.subject || guideText(r.code, p.firstName).subject, body: r.body || guideText(r.code, p.firstName).body }, byName, profileId);
}

/** Every hand sent guide on a job, newest first, for the panel. */
export async function guidesForJob(jobId: number) {
  const rows = await db.select().from(schema.careGuideSends).where(eq(schema.careGuideSends.jobId, jobId)).orderBy(desc(schema.careGuideSends.id));
  const now = Date.now();
  return rows.map((r) => {
    const stuck = r.status === "sending" && now - r.updatedAt.getTime() > STUCK_MS;
    return {
      id: r.id,
      code: r.code,
      title: titleOf(r.code),
      contactId: r.contactId,
      to: r.toAddress,
      role: r.role,
      status: stuck ? ("failed" as const) : (r.status as "sending" | "sent" | "failed"),
      error: stuck ? "It stopped part way. Check the job's conversation first: if it is not there, press Retry." : r.error,
      at: r.updatedAt.getTime(),
      byName: r.byName,
      messageId: r.messageId,
    };
  });
}
