import { z } from "zod";
import { desc, eq, inArray } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, type Actor } from "../middleware/auth";
import { getObject, signGet } from "../lib/s3";
import { transcribeAudio } from "../agent/transcribe";
import { findMentions, noDashes, planMemo, type MemoAction, type MemoPlan } from "../agent/memo";
import {
  buildCardContext,
  findCandidates,
  jobCustomer,
  localToDate,
  nowStrings,
  sayLocal,
  TZ,
  type Candidate,
} from "../lib/memo-context";
import { ensureForContact } from "../lib/conversations";
import { normaliseMobile } from "../lib/sms";
import { buildQuoteFromTranscript } from "./voiceQuotes";
import { createJob } from "./jobs";
import { createContact } from "./contacts";
import { sendConversationMessage } from "./conversations";

/* ---------------------------------------------------------------------------
 * VOICE MEMOS
 *
 * One recording, any number of things done. Recorded from a job or client card
 * the memo already knows who it is about. Recorded from the global mic button
 * it works out the client from what was said, and offers a new client when
 * nobody matches.
 *
 * What happens straight away and what waits for a tap:
 *   straight away   notes, tasks, reminders, new jobs, draft quotes
 *   one tap         customer email and SMS (drafted, editable, then Send)
 *   confirm         bookings and job status moves
 *   waits           anything that needs a client, while the client is new or
 *                   the match is unsure. It runs the moment he picks or creates
 *                   the client.
 *
 * Stored on `voice_quote_captures` like a voice quote, with the plan and the
 * state of each action as JSON in `extracted_json` (kind "memo").
 * ------------------------------------------------------------------------- */

export type ActionState = "pending" | "done" | "draft" | "confirm" | "waiting_client" | "sent" | "dismissed" | "failed";

export interface StoredAction extends MemoAction {
  id: number;
  state: ActionState;
  /** What happened, in a few words, and where to go to see it. */
  resultLabel: string | null;
  resultHref: string | null;
  error: string | null;
  /** Resolved for drafts: the address or number it will go to. */
  to: string | null;
  /** schedule: the line the board's booking box reads. */
  bookingLine: string | null;
  /** Human label for the job the action is on. */
  jobLabel: string | null;
}

export interface StoredMemo {
  kind: "memo";
  source: "job" | "contact" | "global";
  summary: string;
  contextJobId: number | null;
  newJobId: number | null;
  client: MemoPlan["client"] & { name: string | null; candidates: Candidate[] };
  actions: StoredAction[];
}

const isMemo = (json: string | null): boolean => {
  if (!json) return false;
  try {
    return (JSON.parse(json) as { kind?: string }).kind === "memo";
  } catch {
    return false;
  }
};

function readMemo(row: typeof schema.voiceQuoteCaptures.$inferSelect): StoredMemo | null {
  if (!row.extractedJson) return null;
  try {
    const m = JSON.parse(row.extractedJson) as Partial<StoredMemo>;
    return m.kind === "memo" && Array.isArray(m.actions) ? (m as StoredMemo) : null;
  } catch {
    return null;
  }
}

async function saveMemo(id: number, memo: StoredMemo, extra: Partial<typeof schema.voiceQuoteCaptures.$inferInsert> = {}) {
  await db
    .update(schema.voiceQuoteCaptures)
    .set({ extractedJson: JSON.stringify(memo), updatedAt: new Date(), ...extra })
    .where(eq(schema.voiceQuoteCaptures.id, id));
}

async function loadMemo(id: number) {
  const [row] = await db.select().from(schema.voiceQuoteCaptures).where(eq(schema.voiceQuoteCaptures.id, id));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Memo not found" });
  const memo = readMemo(row);
  if (!memo || !memo.actions) throw new ORPCError("BAD_REQUEST", { message: "That recording has no memo plan yet." });
  return { row, memo };
}

const fullName = (c: { firstName: string; lastName: string } | null | undefined) =>
  c ? `${c.firstName} ${c.lastName}`.trim() : "";

async function profileFor(actor: Actor) {
  const [p] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, actor.userId)).limit(1);
  return p ?? null;
}

async function jobLabel(jobId: number | null) {
  if (!jobId) return null;
  const [j] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  return j ? `#${j.number}${j.title ? ` ${j.title}` : ""}` : null;
}

/** The client is settled enough to act on. */
const clientReady = (m: StoredMemo) => m.client.kind === "context" || m.client.kind === "existing" || m.client.kind === "none";

/**
 * Which job an action lands on: its own, the new one, else the card it was
 * recorded on. A memo that made a job and has no other job in play puts the
 * rest of its actions on that job, so the email goes on the new job's thread.
 */
const targetJob = (m: StoredMemo, a: StoredAction) =>
  a.jobId ?? (a.onNewJob ? m.newJobId : null) ?? m.contextJobId ?? m.newJobId ?? null;

/* ---------------------------------------------------------------------------
 * Executing the plan
 * ------------------------------------------------------------------------- */

async function contactById(id: number | null) {
  if (!id) return null;
  const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, id));
  return c ?? null;
}

/** Puts the new client's name and number on a reminder, so it reads on its own. */
function whoLine(m: StoredMemo) {
  if (m.client.kind === "new") {
    const n = [m.client.firstName, m.client.lastName].filter(Boolean).join(" ");
    return [n && `Client: ${n}`, m.client.mobile && `Mobile: ${m.client.mobile}`].filter(Boolean).join(", ");
  }
  return m.client.name ? `Client: ${m.client.name}` : "";
}

async function runOne(captureId: number, m: StoredMemo, a: StoredAction, actor: Actor, transcript: string) {
  const contact = await contactById(m.client.contactId);
  const needsClient = ["note", "create_job", "quote"].includes(a.kind);
  if (needsClient && !clientReady(m)) {
    a.state = "waiting_client";
    return;
  }

  switch (a.kind) {
    case "reminder":
    case "task": {
      const profile = await profileFor(actor);
      const remindAt = a.kind === "reminder" ? (localToDate(a.remindAt) ?? new Date(Date.now() + 60 * 60_000)) : null;
      const who = whoLine(m);
      const [row] = await db
        .insert(schema.officeTasks)
        .values({
          jobId: targetJob(m, a),
          title: (a.title || "Follow up").slice(0, 200),
          detail: [a.detail, who].filter(Boolean).join("\n"),
          assignedProfileId: profile?.id ?? null,
          assignedName: actor.name,
          dueDate:
            a.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(a.dueDate)
              ? a.dueDate
              : remindAt
                ? remindAt.toLocaleDateString("en-CA", { timeZone: TZ })
                : null,
          remindAt,
          createdByName: actor.name,
        })
        .returning();
      a.state = "done";
      a.resultLabel = remindAt ? `Reminder set for ${sayLocal(remindAt)}` : a.dueDate ? `Task added, due ${a.dueDate}` : "Task added";
      a.resultHref = "/";
      if (row && remindAt) a.remindAt = remindAt.toISOString();
      return;
    }

    case "note": {
      const jobId = targetJob(m, a);
      const body = a.detail || transcript;
      if (jobId) {
        await db.insert(schema.activityLog).values({
          jobId,
          contactId: contact?.id ?? null,
          entityType: "job",
          entityId: jobId,
          action: "note",
          detail: body,
          actorName: actor.name,
          actorRole: actor.role,
        });
        a.state = "done";
        a.resultLabel = `Note added to job ${a.jobLabel ?? ""}`.trim();
        a.resultHref = `/jobs/${jobId}`;
      } else if (contact) {
        await db.insert(schema.activityLog).values({
          contactId: contact.id,
          entityType: "contact",
          entityId: contact.id,
          action: "note",
          detail: body,
          actorName: actor.name,
          actorRole: actor.role,
        });
        a.state = "done";
        a.resultLabel = `Note added to ${fullName(contact)}`;
        a.resultHref = `/clients/${contact.id}`;
      } else {
        // Nobody to hang it on, so it becomes an office task rather than vanishing.
        const profile = await profileFor(actor);
        await db.insert(schema.officeTasks).values({
          title: body.slice(0, 120),
          detail: body,
          assignedProfileId: profile?.id ?? null,
          assignedName: actor.name,
          createdByName: actor.name,
        });
        a.state = "done";
        a.resultLabel = "No client, so it was added as a task";
        a.resultHref = "/";
      }
      return;
    }

    case "create_job": {
      let siteId: number | null = null;
      if (contact?.address) {
        const [site] = await db.select().from(schema.sites).where(eq(schema.sites.contactId, contact.id)).limit(1);
        if (site) siteId = site.id;
        else {
          const [created] = await db
            .insert(schema.sites)
            .values({
              address: contact.address,
              suburb: contact.suburb ?? "",
              postcode: contact.postcode,
              contactId: contact.id,
            })
            .returning();
          siteId = created?.id ?? null;
        }
      }
      const job = await createJob(
        {
          title: a.title ?? "",
          description: a.detail ?? null,
          contactId: contact?.id ?? null,
          siteId,
          source: "phone",
        },
        actor,
      );
      if (!job) throw new Error("The job was not created");
      m.newJobId = job.id;
      a.state = "done";
      a.resultLabel = `Job #${job.number} created`;
      a.resultHref = `/jobs/${job.id}`;
      a.jobLabel = `#${job.number}${job.title ? ` ${job.title}` : ""}`;
      await db.update(schema.voiceQuoteCaptures).set({ jobId: job.id }).where(eq(schema.voiceQuoteCaptures.id, captureId));
      return;
    }

    case "quote": {
      const built = await buildQuoteFromTranscript(
        a.quoteBrief || transcript,
        { contactId: contact?.id ?? null, companyId: null, jobId: targetJob(m, a) },
        actor,
      );
      a.state = "done";
      a.resultLabel =
        `Quote #${built.quote.number} drafted, ${built.lineCount} line${built.lineCount === 1 ? "" : "s"}` +
        (built.flaggedCount ? `, ${built.flaggedCount} to check` : "");
      a.resultHref = `/quotes/${built.quote.id}`;
      await db
        .update(schema.voiceQuoteCaptures)
        .set({ quoteId: built.quote.id })
        .where(eq(schema.voiceQuoteCaptures.id, captureId));
      return;
    }

    case "email":
    case "sms": {
      a.state = "draft";
      // Only once the client is settled. A guessed match must not show its number.
      a.to = clientReady(m) ? (a.kind === "email" ? (contact?.email ?? null) : (contact?.mobile ?? null)) : null;
      if (a.kind === "email" && !a.subject) a.subject = "An update on your flooring";
      return;
    }

    case "schedule": {
      const jobId = targetJob(m, a);
      const [job] = jobId ? await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)) : [];
      a.bookingLine = [
        a.bookingInstaller,
        job ? String(job.number) : null,
        a.bookingStartDate,
        a.bookingDays ? `${a.bookingDays} days` : null,
        a.bookingWindow?.replace(/\s+/g, ""),
      ]
        .filter(Boolean)
        .join(" ");
      a.state = "confirm";
      return;
    }

    case "job_status": {
      a.state = "confirm";
      if (a.statusId) {
        const [s] = await db.select().from(schema.jobStatuses).where(eq(schema.jobStatuses.id, a.statusId));
        a.resultLabel = s ? `Move to ${s.name}` : null;
      }
      return;
    }
  }
}

/** Runs everything still pending or waiting on the client, in a safe order. */
async function runActions(captureId: number, m: StoredMemo, actor: Actor, transcript: string) {
  const order = (a: StoredAction) => (a.kind === "create_job" ? 0 : 1);
  const todo = m.actions
    .filter((a) => a.state === "pending" || a.state === "waiting_client")
    .sort((x, y) => order(x) - order(y));
  for (const a of todo) {
    try {
      a.jobLabel = a.jobLabel ?? (await jobLabel(targetJob(m, a)));
      await runOne(captureId, m, a, actor, transcript);
    } catch (err) {
      a.state = "failed";
      a.error = err instanceof Error ? err.message : String(err);
    }
  }
  // Drafts waiting on a client get their recipient once there is one.
  if (clientReady(m)) {
    const c = await contactById(m.client.contactId);
    for (const a of m.actions) {
      if (a.state === "draft") a.to = a.kind === "email" ? (c?.email ?? null) : (c?.mobile ?? null);
    }
  }
}

const startInput = z.object({
  audioKey: z.string().min(1),
  durationSeconds: z.number().nullable().optional(),
  jobId: z.number().nullable().optional(),
  contactId: z.number().nullable().optional(),
});

async function runMemo(captureId: number, input: z.infer<typeof startInput>, actor: Actor) {
  try {
    const audio = await getObject(input.audioKey);
    const transcript = (await transcribeAudio(new Uint8Array(audio))).trim();
    if (!transcript) throw new Error("Nothing was heard on that recording.");
    await db
      .update(schema.voiceQuoteCaptures)
      .set({ transcript, status: "routing", updatedAt: new Date() })
      .where(eq(schema.voiceQuoteCaptures.id, captureId));

    const fromCard = Boolean(input.jobId || input.contactId);
    let contextText: string | null = null;
    let cardContact: typeof schema.contacts.$inferSelect | null = null;
    let candidates: Candidate[] = [];
    let candidateText: string | null = null;

    if (fromCard) {
      const ctx = await buildCardContext({ jobId: input.jobId ?? null, contactId: input.contactId ?? null });
      contextText = ctx.text;
      cardContact = ctx.contact;
    } else {
      const mentions = await findMentions(transcript);
      const found = await findCandidates(mentions);
      candidates = found.list;
      candidateText = found.text;
    }

    const [installers, statuses] = await Promise.all([
      db.select({ name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.active, true)),
      db
        .select({ id: schema.jobStatuses.id, name: schema.jobStatuses.name })
        .from(schema.jobStatuses)
        .where(eq(schema.jobStatuses.active, true)),
    ]);

    const plan = await planMemo({
      transcript,
      ...nowStrings(),
      speakerName: actor.name || "Damien",
      context: contextText,
      candidates: candidateText,
      installers: installers.map((i) => i.name),
      statuses,
    });

    // The card wins over anything the model thinks it heard.
    let client: StoredMemo["client"];
    if (fromCard) {
      client = {
        ...plan.client,
        kind: cardContact ? "context" : "none",
        contactId: cardContact?.id ?? null,
        name: cardContact ? fullName(cardContact) : null,
        candidates: [],
      };
    } else {
      let kind = plan.client.kind === "context" ? "unsure" : plan.client.kind;
      let contactId = plan.client.contactId;
      // Only a contact that was actually offered can be picked.
      if ((kind === "existing" || kind === "unsure") && !candidates.some((c) => c.id === contactId)) {
        kind = candidates.length ? "unsure" : "none";
        contactId = candidates[0]?.id ?? null;
      }
      const picked = candidates.find((c) => c.id === contactId);
      client = { ...plan.client, kind, contactId, name: picked?.name ?? null, candidates };
    }

    const memo: StoredMemo = {
      kind: "memo",
      source: input.jobId ? "job" : input.contactId ? "contact" : "global",
      summary: noDashes(plan.summary),
      contextJobId: input.jobId ?? null,
      newJobId: null,
      client,
      actions: plan.actions.map((a, i) => ({
        ...a,
        id: i,
        state: "pending",
        resultLabel: null,
        resultHref: null,
        error: null,
        to: null,
        bookingLine: null,
        jobLabel: null,
      })),
    };

    await runActions(captureId, memo, actor, transcript);
    await saveMemo(captureId, memo, {
      status: "ready",
      contactId: client.contactId && clientReady(memo) ? client.contactId : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong with that memo.";
    console.error(`[memos] capture ${captureId} failed:`, err);
    await db
      .update(schema.voiceQuoteCaptures)
      .set({ status: "failed", errorMessage: message, updatedAt: new Date() })
      .where(eq(schema.voiceQuoteCaptures.id, captureId));
  }
}

function view(row: typeof schema.voiceQuoteCaptures.$inferSelect) {
  const memo = readMemo(row);
  return {
    id: row.id,
    status: row.status,
    errorMessage: row.errorMessage,
    transcript: row.transcript,
    createdAt: row.createdAt,
    capturedByName: row.capturedByName,
    quoteId: row.quoteId,
    jobId: row.jobId,
    contactId: row.contactId,
    memo: memo && memo.actions ? memo : null,
  };
}
export type MemoView = ReturnType<typeof view>;

const actionRef = z.object({ id: z.number(), actionId: z.number() });

function actionOf(memo: StoredMemo, actionId: number) {
  const a = memo.actions.find((x) => x.id === actionId);
  if (!a) throw new ORPCError("NOT_FOUND", { message: "That action is not on this memo." });
  return a;
}

export const memos = {
  /**
   * Answers at once with the capture id, then works in the background. The
   * published server drops any request that is quiet for 10 seconds, and
   * Whisper plus two model calls can run past that. The client polls `get`.
   */
  start: adminOnly.input(startInput).handler(async ({ input, context }) => {
    const [row] = await db
      .insert(schema.voiceQuoteCaptures)
      .values({
        audioKey: input.audioKey,
        durationSeconds: input.durationSeconds ?? null,
        contactId: input.contactId ?? null,
        jobId: input.jobId ?? null,
        status: "transcribing",
        extractedJson: JSON.stringify({ kind: "memo" }),
        capturedByName: context.actor.name,
      })
      .returning();
    if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not start the memo" });
    runMemo(row.id, input, context.actor).catch((err) => console.error(`[memos] ${row.id}`, err));
    return { captureId: row.id };
  }),

  get: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [row] = await db.select().from(schema.voiceQuoteCaptures).where(eq(schema.voiceQuoteCaptures.id, input.id));
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Memo not found" });
    return { ...view(row), audioUrl: await signGet(row.audioKey) };
  }),

  /** Every voice recording, memo or quote, newest first. The Voice drafts page. */
  list: adminOnly
    .input(z.object({ limit: z.number().int().min(1).max(200).default(60) }).default({ limit: 60 }))
    .handler(async ({ input }) => {
      const rows = await db
        .select()
        .from(schema.voiceQuoteCaptures)
        .orderBy(desc(schema.voiceQuoteCaptures.createdAt))
        .limit(input.limit);
      const quoteIds = rows.map((r) => r.quoteId).filter((x): x is number => x != null);
      const quotes = quoteIds.length
        ? await db
            .select({ id: schema.quotes.id, number: schema.quotes.number, status: schema.quotes.status })
            .from(schema.quotes)
            .where(inArray(schema.quotes.id, quoteIds))
        : [];
      const quoteMap = new Map(quotes.map((q) => [q.id, q]));
      return rows.map((r) => ({
        ...view(r),
        kind: isMemo(r.extractedJson) ? ("memo" as const) : ("quote" as const),
        quote: r.quoteId ? (quoteMap.get(r.quoteId) ?? null) : null,
      }));
    }),

  /** Edit a draft's wording before it goes. */
  updateDraft: adminOnly
    .input(actionRef.extend({ subject: z.string().nullable().optional(), body: z.string().min(1) }))
    .handler(async ({ input }) => {
      const { memo } = await loadMemo(input.id);
      const a = actionOf(memo, input.actionId);
      if (a.state !== "draft") throw new ORPCError("BAD_REQUEST", { message: "Only a draft can be edited." });
      a.body = noDashes(input.body);
      if (input.subject !== undefined) a.subject = input.subject;
      await saveMemo(input.id, memo);
      return { ok: true };
    }),

  /**
   * The one tap. Goes out through the same path as a message typed on the job
   * thread: logged in the conversation, opt-out on customer texts, two-way number.
   */
  sendDraft: adminOnly
    .input(
      actionRef.extend({
        subject: z.string().nullable().optional(),
        body: z.string().min(1).optional(),
        /** Typed in on the draft when the client has no email or mobile yet. Saved to their record. */
        toAddress: z.string().trim().max(200).nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { memo } = await loadMemo(input.id);
      const a = actionOf(memo, input.actionId);
      if (a.state !== "draft" && a.state !== "failed")
        throw new ORPCError("BAD_REQUEST", { message: "That message has already been dealt with." });
      if (a.kind !== "email" && a.kind !== "sms") throw new ORPCError("BAD_REQUEST", { message: "Not a message." });
      if (!clientReady(memo) || !memo.client.contactId)
        throw new ORPCError("BAD_REQUEST", { message: "Pick or create the client first, then send." });

      if (input.body) a.body = noDashes(input.body);
      if (input.subject !== undefined) a.subject = input.subject;
      if (!a.body) throw new ORPCError("BAD_REQUEST", { message: "The message is empty." });

      if (input.toAddress) {
        const c = await contactById(memo.client.contactId);
        if (!c) throw new ORPCError("NOT_FOUND", { message: "Client not found." });
        if (a.kind === "email") {
          const email = input.toAddress.toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            throw new ORPCError("BAD_REQUEST", { message: "That email address doesn't look right." });
          if (!c.email) await db.update(schema.contacts).set({ email, updatedAt: new Date() }).where(eq(schema.contacts.id, c.id));
          a.to = c.email ?? email;
        } else {
          const mobile = normaliseMobile(input.toAddress);
          if (!mobile) throw new ORPCError("BAD_REQUEST", { message: "That needs to be an Australian mobile, like 0412 345 678." });
          if (!c.mobile) await db.update(schema.contacts).set({ mobile, updatedAt: new Date() }).where(eq(schema.contacts.id, c.id));
          a.to = c.mobile ?? mobile;
        }
      }

      const jobId = targetJob(memo, a);
      const conv = jobId ? null : await ensureForContact(memo.client.contactId, a.subject ?? "Terra Flooring");
      const out = await sendConversationMessage(
        {
          jobId: jobId ?? undefined,
          conversationId: conv?.id,
          audience: "customer",
          channel: a.kind,
          subject: a.kind === "email" ? (a.subject ?? undefined) : undefined,
          body: a.body,
          contactId: memo.client.contactId,
        },
        context.actor,
      );

      if (out.ok) {
        a.state = "sent";
        a.error = null;
        a.resultLabel = a.kind === "email" ? "Email sent" : "Text sent";
        a.resultHref = jobId ? `/jobs/${jobId}` : `/clients/${memo.client.contactId}`;
      } else {
        a.state = "failed";
        a.error = "reason" in out && out.reason ? String(out.reason) : "It did not send.";
      }
      await saveMemo(input.id, memo);
      return { ok: out.ok, error: a.error };
    }),

  /** Leave it, without doing it. */
  dismiss: adminOnly.input(actionRef).handler(async ({ input }) => {
    const { memo } = await loadMemo(input.id);
    const a = actionOf(memo, input.actionId);
    if (a.state === "done" || a.state === "sent")
      throw new ORPCError("BAD_REQUEST", { message: "That one has already happened." });
    a.state = "dismissed";
    await saveMemo(input.id, memo);
    return { ok: true };
  }),

  /** A booking made through the board's booking box, recorded back on the memo. */
  markBooked: adminOnly
    .input(actionRef.extend({ label: z.string(), taskId: z.number() }))
    .handler(async ({ input }) => {
      const { memo } = await loadMemo(input.id);
      const a = actionOf(memo, input.actionId);
      a.state = "done";
      a.resultLabel = noDashes(input.label);
      a.resultHref = "/schedule";
      await saveMemo(input.id, memo);
      return { ok: true };
    }),

  /** Confirm a job status move. */
  confirmStatus: adminOnly.input(actionRef).handler(async ({ input, context }) => {
    const { memo } = await loadMemo(input.id);
    const a = actionOf(memo, input.actionId);
    if (a.kind !== "job_status" || a.state !== "confirm" || !a.statusId)
      throw new ORPCError("BAD_REQUEST", { message: "Nothing to confirm." });
    const jobId = targetJob(memo, a);
    if (!jobId) throw new ORPCError("BAD_REQUEST", { message: "No job to move." });
    const [status] = await db.select().from(schema.jobStatuses).where(eq(schema.jobStatuses.id, a.statusId));
    if (!status) throw new ORPCError("BAD_REQUEST", { message: "That status no longer exists." });
    await db.update(schema.jobs).set({ statusId: status.id, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId));
    await db.insert(schema.activityLog).values({
      jobId,
      entityType: "job",
      entityId: jobId,
      action: "status_changed",
      detail: `Status → ${status.name} (voice memo)`,
      actorName: context.actor.name,
      actorRole: context.actor.role,
    });
    a.state = "done";
    a.resultLabel = `Moved to ${status.name}`;
    a.resultHref = `/jobs/${jobId}`;
    await saveMemo(input.id, memo);
    return { ok: true };
  }),

  /**
   * Settle who the memo is about: one of the matches, a brand new client from
   * the details in the memo (editable first), or nobody. Whatever was waiting
   * on the client runs straight after.
   */
  resolveClient: adminOnly
    .input(
      z.object({
        id: z.number(),
        contactId: z.number().nullable().optional(),
        create: z
          .object({
            firstName: z.string().min(1),
            lastName: z.string().default(""),
            mobile: z.string().nullable().optional(),
            email: z.string().nullable().optional(),
            address: z.string().nullable().optional(),
            suburb: z.string().nullable().optional(),
            postcode: z.string().nullable().optional(),
            notes: z.string().nullable().optional(),
          })
          .optional(),
        none: z.boolean().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { row, memo } = await loadMemo(input.id);
      if (input.create) {
        const mobile = input.create.mobile ? (normaliseMobile(input.create.mobile) ?? input.create.mobile) : null;
        const c = await createContact({ ...input.create, mobile, source: "phone" }, context.actor);
        if (!c) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "The client was not created." });
        memo.client = { ...memo.client, kind: "existing", contactId: c.id, name: fullName(c) };
      } else if (input.contactId) {
        const c = await contactById(input.contactId);
        if (!c) throw new ORPCError("NOT_FOUND", { message: "Client not found." });
        memo.client = { ...memo.client, kind: "existing", contactId: c.id, name: fullName(c) };
      } else if (input.none) {
        memo.client = { ...memo.client, kind: "none", contactId: null, name: null };
      } else {
        throw new ORPCError("BAD_REQUEST", { message: "Pick a client, create one, or say none." });
      }
      await runActions(input.id, memo, context.actor, row.transcript);
      await saveMemo(input.id, memo, { contactId: memo.client.contactId });
      return { ok: true, contactId: memo.client.contactId };
    }),

  /** Customer on a job, for the card buttons to label themselves. */
  cardLabel: adminOnly
    .input(z.object({ jobId: z.number().nullable(), contactId: z.number().nullable() }))
    .handler(async ({ input }) => {
      if (input.contactId) return { name: fullName(await contactById(input.contactId)) || null };
      if (input.jobId) return { name: fullName(await jobCustomer(input.jobId)) || null };
      return { name: null };
    }),
};
