import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { emailKey, findMatches, phoneKey } from "../contact-merge";
import { lookUpAddress } from "../lead-intake";
import { jobText } from "../refs";
import { normaliseMobile } from "../sms";
import { EMAIL_RE, quoteRecipients } from "../quote-email";
import { claimSend, releaseSend, runSend } from "../quote-send";
import { quoteRefOf } from "../quote-number";
import { assertBillable } from "../callbacks";
import { bookingBlock } from "../prep";
import { checkDays } from "../availability";
import { createJob } from "../../routes/jobs";
import { bookTask, createTask } from "../../routes/tasks";
import { assertReadyToGoOut, recordPriceHistory } from "../../routes/quotes";
import {
  AGENT_ACTOR,
  FAILED_SAY,
  jobNote,
  logRead,
  matchedIds,
  patchCall,
  runAction,
  upsertCall,
  type ActionOutcome,
  type RetellCall,
  type ToolResult,
} from "./calls";
import { checkIdentity, contactOnJob, currentQuotes, jobByRef, jobIdsFor, jobsForCaller, jobSummary, MAX_VERIFY_ATTEMPTS, type CallRow } from "./caller";
import { CALL_TYPES, inOfficeHours, loadPhoneConfig, type CallType, type PhoneConfig } from "./config";
import { createFollowup } from "./followups";
import { membersOf, settlePerson } from "./routing";
import { localDate } from "../local-date";
import { freeSlots, openVisitOnJob, parseSlot, sayDay, sayTime, slotFree, visitPeople, visitSkillId } from "./visits";

/* ---------------------------------------------------------------------------
 * The agent's tools (Retell custom functions, 5 Nov).
 *
 * Retell posts {name, call, args} to /api/retell/fn/<name>. Every tool:
 *   - checks the master switch and its own action switch first,
 *   - on an existing job, checks the caller proved who they are and is on
 *     that job. A caller-ID match alone is never enough,
 *   - writes through runAction, so a retry never does it twice and the
 *     caller is only told "done" after it is saved,
 *   - hands anything it can't do to a person as a follow-up, and says so.
 * Prices, discounts, accepting a quote and payments are never done here.
 * ------------------------------------------------------------------------- */

type Args = Record<string, unknown>;
type Ctx = { cfg: PhoneConfig; call: CallRow; retell: RetellCall; args: Args; now: Date };
type ActionKey = keyof PhoneConfig["actions"];
type Tool = { action: ActionKey | null; run: (ctx: Ctx) => Promise<ToolResult> };

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const yes = (v: unknown) => v === true || v === "true" || v === "yes";
const refuse = (say: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, status: "refused", say, data });
const OFF_SAY = "I can't do that one myself today. I'll get someone from the team to call you back about it.";
const VERIFY_FIRST = "Before I can look at or change anything on a job, I need to confirm who I'm speaking with.";

const bneStamp = (d: Date) => d.toLocaleString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

function callerLine(call: CallRow, name?: string | null) {
  const num = call.withheld ? "number withheld" : (call.fromNumber ?? "no number");
  return `${name ? `${name}, ` : ""}${num}`;
}

async function contactName(id: number | null | undefined) {
  if (!id) return null;
  const [c] = await db.select({ f: schema.contacts.firstName, l: schema.contacts.lastName }).from(schema.contacts).where(eq(schema.contacts.id, id));
  return c ? `${c.f ?? ""} ${c.l ?? ""}`.trim() : null;
}

/** A follow-up raised from inside a call. One per call and purpose. */
async function raise(ctx: Ctx, purpose: string, type: CallType, title: string, detail: string, opts: { jobId?: number | null; priority?: "normal" | "high" | "urgent" } = {}) {
  const name = await contactName(ctx.call.verifiedContactId ?? ctx.call.contactId);
  return createFollowup(ctx.cfg, {
    dedupeKey: `call:${ctx.call.id}:${purpose}`,
    callType: type,
    title,
    detail,
    callId: ctx.call.id,
    jobId: opts.jobId ?? ctx.call.jobId,
    contactId: ctx.call.verifiedContactId ?? ctx.call.contactId,
    priority: opts.priority,
    callerLine: callerLine(ctx.call, name),
    now: ctx.now,
  });
}

/** A write that failed or can't be confirmed: a person hears about it straight away. */
function failureHook(ctx: Ctx, name: string) {
  return {
    onFailure: async (_o: ActionOutcome, err: string) => {
      await raise(ctx, `failure:${name}`, "failure", `AI call action not confirmed: ${name.replace(/_/g, " ")}`, `The agent tried "${name}" on this call and it did not finish cleanly (${err}). Check whether it happened and confirm with the caller.`, { priority: "high" });
    },
  };
}

/**
 * The job a tool is about, if the caller may touch it: the enquiry made on
 * this call, or a job of the person they proved they are.
 */
async function jobFor(ctx: Ctx): Promise<{ ok: true; jobId: number } | { ok: false; result: ToolResult }> {
  const ref = str(ctx.args.job_ref, 40);
  if (ctx.call.newEnquiry && ctx.call.jobId && !ref) return { ok: true, jobId: ctx.call.jobId };
  if (!ctx.call.verifiedContactId) return { ok: false, result: refuse(VERIFY_FIRST, { needs: "verify_caller" }) };
  if (ref) {
    const j = await jobByRef(ref);
    if (!j || !(await contactOnJob(ctx.call.verifiedContactId, j.id))) {
      if (ctx.call.newEnquiry && ctx.call.jobId && j?.id === ctx.call.jobId) return { ok: true, jobId: j.id };
      return { ok: false, result: refuse("I can't find that job number under your name. Could you check the number for me?") };
    }
    return { ok: true, jobId: j.id };
  }
  const ids = await jobIdsFor(ctx.call.verifiedContactId);
  if (ids.length === 1) return { ok: true, jobId: ids[0]! };
  if (!ids.length) return { ok: false, result: refuse("I can't see a job under your name yet.") };
  return { ok: false, result: refuse("You've got more than one job with us. Which one is this about?", { jobs: await jobsForCaller(ctx.call.verifiedContactId), needs: "job_ref" }) };
}

async function setCallJob(ctx: Ctx, jobId: number, type?: CallType) {
  const patch: Partial<typeof schema.phoneCalls.$inferInsert> = { jobId };
  if (type && (ctx.call.callType === "other" || ctx.call.callType === "existing_job")) patch.callType = type;
  ctx.call = await patchCall(ctx.call.id, patch);
}

/* ------------------------------- the tools ------------------------------- */

const tools: Record<string, Tool> = {
  /** What the caller ID tells us. Never names anyone: that waits for verify_caller. */
  identify_caller: {
    action: "lookup",
    run: async (ctx) => {
      const n = matchedIds(ctx.call).length;
      return {
        ok: true,
        status: "done",
        say: "",
        data: {
          number_withheld: ctx.call.withheld,
          number_known: n > 0,
          shared_number: n > 1,
          office_open: inOfficeHours(ctx.cfg, ctx.now),
          next_step: ctx.call.verifiedContactId ? "already verified" : "Ask for their surname and the street address of the job (or the email we have, or the job number) before talking about any job.",
        },
      };
    },
  },

  verify_caller: {
    action: "lookup",
    run: async (ctx) => {
      if (ctx.call.verifiedContactId) {
        return { ok: true, status: "done", say: "Thanks, you're already confirmed.", data: { first_name: (await contactName(ctx.call.verifiedContactId))?.split(" ")[0] ?? "", jobs: await jobsForCaller(ctx.call.verifiedContactId) } };
      }
      if (ctx.call.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        return refuse("I'm not able to confirm the details over the phone, sorry. I'll have someone from the office call you back on the number we have on file.", { locked: true });
      }
      const check = await checkIdentity(matchedIds(ctx.call), {
        lastName: str(ctx.args.last_name, 80),
        firstName: str(ctx.args.first_name, 80) || null,
        street: str(ctx.args.street_address, 200) || null,
        email: str(ctx.args.email, 200) || null,
        jobRef: str(ctx.args.job_ref, 40) || null,
      });
      const attempts = ctx.call.verifyAttempts + 1;
      if (!check.ok) {
        ctx.call = await patchCall(ctx.call.id, { verifyAttempts: attempts });
        const left = MAX_VERIFY_ATTEMPTS - attempts;
        return refuse(
          left > 0 ? "Sorry, those details don't match what I have. Could you give me the street address of the job, or the email you gave us?" : "I'm not able to confirm the details over the phone, sorry. I'll have someone from the office call you back.",
          { attempts_left: left, reason: check.reason === "more than one person matches" ? "need one more detail" : "no match" },
        );
      }
      ctx.call = await patchCall(ctx.call.id, { verifyAttempts: attempts, verifiedContactId: check.contact.id, contactId: check.contact.id, verifyMethod: check.method, verifiedAt: new Date() });
      const jobs = await jobsForCaller(check.contact.id);
      if (jobs.length === 1) {
        const j = await jobByRef(jobs[0]!.job_ref);
        if (j) await setCallJob(ctx, j.id, "existing_job");
      }
      return { ok: true, status: "done", say: `Thanks ${check.contact.firstName ?? ""}, that's confirmed.`.replace("  ", " "), data: { first_name: check.contact.firstName ?? "", jobs } };
    },
  },

  get_job_summary: {
    action: "lookup",
    run: async (ctx) => {
      const j = await jobFor(ctx);
      if (!j.ok) return j.result;
      await setCallJob(ctx, j.jobId, "existing_job");
      const s = await jobSummary(j.jobId);
      if (!s) return refuse("I can't open that job just now.");
      return { ok: true, status: "done", say: "", data: s };
    },
  },

  create_enquiry: {
    action: "enquiry",
    run: async (ctx) => {
      const first = str(ctx.args.first_name, 60);
      const last = str(ctx.args.last_name, 60);
      const what = str(ctx.args.what_they_need, 1000);
      const suburb = str(ctx.args.suburb, 80);
      const address = str(ctx.args.street_address, 200);
      const email = str(ctx.args.email, 200);
      const given = str(ctx.args.mobile, 40);
      if (!first || !what) return refuse("I just need your first name and a quick idea of the job first.", { needs: ["first_name", "what_they_need"] });
      if (ctx.call.newEnquiry && ctx.call.jobId) {
        const [j] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, ctx.call.jobId));
        return { ok: true, status: "done", say: "That's already saved from earlier in the call.", data: { job_ref: j ? jobText(j) : null, already: true } };
      }
      const mobile = normaliseMobile(given) ?? (ctx.call.withheld ? null : normaliseMobile(ctx.call.fromNumber));
      const landline = mobile ? null : given || (ctx.call.withheld ? null : ctx.call.fromNumber);
      return runAction(
        ctx.call,
        "create_enquiry",
        ctx.args,
        async () => {
          // Same person: a matching mobile or email AND the same surname. A shared number alone is not the same person.
          const matches = await findMatches({ mobile, phone: landline, email: EMAIL_RE.test(email) ? email : null });
          const strong = matches.find(
            (m) => (m.reasons.includes("mobile") || m.reasons.includes("email")) && (!last || (m.contact.lastName ?? "").trim().toLowerCase() === last.toLowerCase()),
          );
          const weak = matches.filter((m) => m !== strong);
          const flags = ["From the AI phone agent"];
          if (weak.length) flags.push(`Possible duplicate of ${weak.map((m) => `card #${m.contact.id} (${m.reasons.join(", ")})`).join(", ")}`);

          // Duplicate enquiry: the same person already has an open lead in the last 14 days. Add to it.
          if (strong) {
            const since = new Date(ctx.now.getTime() - 14 * 86_400_000);
            const ids = await jobIdsFor(strong.contact.id);
            const open = ids.length
              ? await db
                  .select({ job: schema.jobs })
                  .from(schema.jobs)
                  .innerJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
                  .where(and(inArray(schema.jobs.id, ids), eq(schema.jobStatuses.stage, "open"), gte(schema.jobs.createdAt, since)))
                  .orderBy(desc(schema.jobs.id))
                  .limit(1)
              : [];
            if (open[0]) {
              const job = open[0].job;
              await jobNote(job.id, `Phone call ${bneStamp(ctx.now)} (AI agent): asked again about ${what}. Kept on this enquiry instead of making a second one.`, "phone_note", strong.contact.id);
              ctx.call = await patchCall(ctx.call.id, { jobId: job.id, contactId: strong.contact.id, newEnquiry: true, callType: "enquiry" });
              return {
                ok: true,
                status: "done",
                // Says nothing about what is already on file: the caller hasn't proved who they are.
                say: "Thanks, I've got all that down and passed it to the team.",
                data: { job_ref: jobText(job), duplicate_of_existing: true },
                entity: { type: "job", id: job.id },
                jobId: job.id,
                needsPerson: `Repeat enquiry from the same person, added to job ${jobText(job)}. Get back to them.`,
              };
            }
          }

          let newSite: Record<string, unknown> | null = null;
          if (address && /\d/.test(address)) {
            const typed = [address, suburb && !address.toLowerCase().includes(suburb.toLowerCase()) ? suburb : ""].filter(Boolean).join(" ");
            const place = await lookUpAddress(typed).catch(() => null);
            newSite = place
              ? { address: place.address, suburb: place.suburb, state: place.state, postcode: place.postcode || null, lat: place.lat, lng: place.lng, placeId: place.placeId, propertyType: "" }
              : { address, suburb, state: "QLD", propertyType: "" };
            if (!place) flags.push("Address not checked with Google");
          } else flags.push(suburb ? "Suburb only, no street address" : "No address");
          if (!ctx.call.fromNumber && !given) flags.push("Number withheld and none given");

          const where = (newSite?.suburb as string | undefined) || suburb;
          const job = await createJob(
            {
              title: `Phone enquiry${where ? ` (${where})` : ""}`.slice(0, 200),
              description: [`AI phone call ${bneStamp(ctx.now)}.`, what, str(ctx.args.notes, 1000)].filter(Boolean).join("\n\n"),
              source: "AI phone call",
              contactId: strong ? strong.contact.id : null,
              contactKey: strong ? null : "caller",
              newContacts: strong
                ? []
                : [{ key: "caller", firstName: first, lastName: last, mobile, phone: landline, email: EMAIL_RE.test(email) ? email : null, suburb: where || null, source: "AI phone call", notes: "Made by the AI phone agent from a call." }],
              newSite: newSite as never,
              billToType: "contact",
            },
            AGENT_ACTOR,
          );
          if (!job) throw new Error("The enquiry job was not made");
          await db.update(schema.jobs).set({ leadFlags: JSON.stringify(flags), updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
          ctx.call = await patchCall(ctx.call.id, { jobId: job.id, contactId: job.contactId ?? null, newEnquiry: true, callType: "enquiry" });
          return {
            ok: true,
            status: "done",
            say: `Thanks ${first}, I've saved your enquiry. Your reference is job ${jobText(job).split("").join(" ")}.`,
            data: { job_ref: jobText(job) },
            entity: { type: "job", id: job.id },
            jobId: job.id,
          };
        },
        failureHook(ctx, "create_enquiry"),
      );
    },
  },

  add_call_note: {
    action: "note",
    run: async (ctx) => {
      const note = str(ctx.args.note, 2000);
      if (note.length < 3) return refuse("What would you like me to note down?");
      const j = await jobFor(ctx);
      if (!j.ok) return j.result;
      return runAction(
        ctx.call,
        "add_call_note",
        { ...ctx.args, job: j.jobId },
        async () => {
          const id = await jobNote(j.jobId, `Phone call ${bneStamp(ctx.now)} (AI agent): ${note}`, "phone_note", ctx.call.verifiedContactId ?? ctx.call.contactId);
          await setCallJob(ctx, j.jobId, "existing_job");
          return { ok: true, status: "done", say: "I've added that note to your job.", entity: { type: "activity", id }, jobId: j.jobId };
        },
        failureHook(ctx, "add_call_note"),
      );
    },
  },

  /** Only what a customer may change, and only after it was read back to them. */
  update_job_details: {
    action: "update",
    run: async (ctx) => {
      const field = str(ctx.args.field, 40);
      const value = str(ctx.args.new_value, 1000);
      const j = await jobFor(ctx);
      if (!j.ok) return j.result;
      if (field !== "access_notes") {
        const fu = await raise(ctx, `update:${field}`, "existing_job", `Caller asked to change ${field.replace(/_/g, " ") || "a detail"}`, `On the call the customer asked to change ${field || "a detail"} to: "${value}". The agent can't change this one. Check and update it.`, { jobId: j.jobId });
        return { ok: true, status: "done", say: "I can't change that one myself, but I've passed it to the team and they'll update it and confirm with you.", needsPerson: fu.row.title, data: { followup: fu.row.id } };
      }
      if (!value) return refuse("What should the access details say?");
      if (!yes(ctx.args.read_back_confirmed)) return refuse("Read the new access details back to the caller and get a yes before saving.", { needs: "read_back_confirmed" });
      return runAction(
        ctx.call,
        "update_job_details",
        { ...ctx.args, job: j.jobId },
        async () => {
          const [job] = await db.select({ accessNotes: schema.jobs.accessNotes }).from(schema.jobs).where(eq(schema.jobs.id, j.jobId));
          const line = `${bneStamp(ctx.now)} from the customer by phone: ${value}`;
          const next = [job?.accessNotes?.trim(), line].filter(Boolean).join("\n");
          await db.update(schema.jobs).set({ accessNotes: next.slice(0, 4000), updatedAt: new Date() }).where(eq(schema.jobs.id, j.jobId));
          await jobNote(j.jobId, `Access details added by the customer on the phone (read back and confirmed): ${value}`, "access_notes_updated", ctx.call.verifiedContactId);
          await setCallJob(ctx, j.jobId, "existing_job");
          return { ok: true, status: "done", say: "Done, I've saved those access details on your job.", entity: { type: "job", id: j.jobId }, jobId: j.jobId };
        },
        failureHook(ctx, "update_job_details"),
      );
    },
  },

  check_availability: {
    action: "measureBooking",
    run: async (ctx) => {
      const part = str(ctx.args.part_of_day, 20);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(str(ctx.args.from_date, 10)) ? str(ctx.args.from_date, 10) : null;
      const { slots, people } = await freeSlots(ctx.cfg, { fromDate: from, partOfDay: part === "morning" || part === "afternoon" ? part : "any", max: 3, now: ctx.now });
      const result: ToolResult = !people.length
        ? refuse("I can't book that online right now. I'll get the team to call you to set a time.", { no_people: true })
        : !slots.length
          ? refuse("I don't have a free time in the next couple of weeks for that. I'll get the team to call you to sort one out.", { none_free: true })
          : { ok: true, status: "done", say: "", data: { slots: slots.map((s) => ({ slot: s.slot, say: `${sayDay(s.date)} at ${sayTime(s.start)}` })), length_minutes: ctx.cfg.visits.durationMins } };
      await logRead(ctx.call, "check_availability", ctx.args, result);
      return result;
    },
  },

  book_visit: {
    action: "measureBooking",
    run: async (ctx) => {
      const slot = parseSlot(ctx.args.slot);
      if (!slot) return refuse("Which of those times would suit? I need one of the times I offered.", { needs: "slot from check_availability" });
      const j = await jobFor(ctx);
      if (!j.ok) return j.result;
      return runAction(
        ctx.call,
        "book_visit",
        { slot: slot.slot, job: j.jobId },
        async () => {
          const skillId = await visitSkillId(ctx.cfg);
          if (!skillId) return { ok: false, status: "refused", say: "I can't book that online right now. I'll get the team to call you to set a time.", needsPerson: "Book a measure: no measure skill is set up." };
          const people = await visitPeople(ctx.cfg, skillId);
          if (!people.includes(slot.installerId)) return { ok: false, status: "refused", say: "That time isn't one I can book. Let me check again." };
          const existing = await openVisitOnJob(j.jobId, skillId);
          if (existing) {
            return { ok: false, status: "refused", say: "There's already a visit set up for this job. I'll get the team to confirm the time with you.", needsPerson: "Caller asked for a measure but one is already on the job. Confirm the time with them." };
          }
          // Checked again at the moment of booking: someone may have taken it since it was offered.
          if (!(await slotFree(ctx.cfg, slot.installerId, slot.date, slot.start))) {
            return { ok: false, status: "refused", say: "Sorry, that time has just gone. Let me find you another one.", data: { slot_gone: true } };
          }
          const [skill] = await db.select({ name: schema.skills.name }).from(schema.skills).where(eq(schema.skills.id, skillId));
          const hours = ctx.cfg.visits.durationMins / 60;
          const task = await createTask(
            { jobId: j.jobId, skillId, title: skill?.name ?? "Measure & quote", description: `Booked by the AI phone agent on a call ${bneStamp(ctx.now)}.${str(ctx.args.notes, 500) ? ` ${str(ctx.args.notes, 500)}` : ""}`, durationHours: hours, crewSize: 1, payType: "per_job" },
            AGENT_ACTOR,
          );
          try {
            await bookTask({ taskId: task!.id, installerId: slot.installerId, dates: [slot.date], arrivalStart: slot.start, arrivalEnd: null, durationHours: hours, coordinateAfterFirst: false, perDay: [] }, AGENT_ACTOR);
          } catch (e) {
            // Nothing half-made: the task made a moment ago is cancelled again.
            await db.update(schema.jobTasks).set({ status: "cancelled", updatedAt: new Date() }).where(eq(schema.jobTasks.id, task!.id));
            await jobNote(j.jobId, `AI phone agent could not book ${slot.date} ${slot.start}: ${(e as Error).message}. The task it made was cancelled.`, "phone_booking_failed");
            return { ok: false, status: "refused", say: "Sorry, that time has just gone. Let me find you another one.", data: { slot_gone: true } };
          }
          await setCallJob(ctx, j.jobId, "measure");
          ctx.call = await patchCall(ctx.call.id, { callType: ctx.call.newEnquiry ? "enquiry" : "measure" });
          return { ok: true, status: "done", say: `You're booked in for ${sayDay(slot.date)} at ${sayTime(slot.start)}.`, data: { date: slot.date, start: slot.start }, entity: { type: "task", id: task!.id }, jobId: j.jobId };
        },
        failureHook(ctx, "book_visit"),
      );
    },
  },

  /** Moving an install. A person does it unless auto-move is on and everything is ready. */
  request_install_change: {
    action: "installChange",
    run: async (ctx) => {
      const j = await jobFor(ctx);
      if (!j.ok) return j.result;
      const wanted = str(ctx.args.preferred_date, 10);
      const why = str(ctx.args.reason, 500);
      return runAction(
        ctx.call,
        "request_install_change",
        { ...ctx.args, job: j.jobId },
        async () => {
          await setCallJob(ctx, j.jobId, "booking");
          const auto = ctx.cfg.installAutoMove && /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? await tryAutoMove(j.jobId, wanted) : { moved: false as const, why: ctx.cfg.installAutoMove ? "no exact date given" : "auto-move is off" };
          if (auto.moved) {
            await jobNote(j.jobId, `Install moved to ${wanted} by the AI phone agent at the customer's request${why ? ` (${why})` : ""}.`, "phone_install_moved");
            return { ok: true, status: "done", say: `Done, I've moved your install to ${sayDay(wanted)}. Your installer will confirm the arrival time.`, entity: { type: "task", id: auto.taskId }, jobId: j.jobId };
          }
          const fu = await raise(ctx, "install_change", "booking", `Install change requested${wanted ? ` for ${wanted}` : ""}`, `The customer asked to change their install${wanted ? ` to ${wanted}` : ""}.${why ? ` Reason: ${why}.` : ""} Not moved automatically: ${auto.why}. Check readiness, move it, and confirm with them.`, { jobId: j.jobId });
          return { ok: true, status: "done", say: "I've passed that to our scheduling team. Nothing has moved yet. They'll check the dates and call you to confirm.", entity: { type: "followup", id: fu.row.id }, jobId: j.jobId, needsPerson: fu.row.title };
        },
        failureHook(ctx, "request_install_change"),
      );
    },
  },

  /** The one current issued quote, again, the same way the office sends it. Anything else goes to a person. */
  resend_quote: {
    action: "quoteResend",
    run: async (ctx) => {
      const j = await jobFor(ctx);
      if (!j.ok) return j.result;
      return runAction(
        ctx.call,
        "resend_quote",
        { job: j.jobId },
        async () => {
          await setCallJob(ctx, j.jobId, "existing_job");
          const toOffice = async (why: string) => {
            const fu = await raise(ctx, "quote_resend", "existing_job", "Caller asked for their quote again", `The customer asked for the quote to be sent again. The agent didn't send it: ${why}.`, { jobId: j.jobId });
            return { ok: true, status: "done" as const, say: "I'll get the office to send that through to you and check it's the right one.", needsPerson: fu.row.title, jobId: j.jobId, entity: { type: "followup", id: fu.row.id } };
          };
          const { issued } = await currentQuotes(j.jobId);
          if (issued.length !== 1) return toOffice(issued.length ? "there is more than one current quote" : "there is no current issued quote");
          const quote = issued[0]!;
          const recipients = await quoteRecipients(quote);
          const [last] = await db
            .select()
            .from(schema.quoteSends)
            .where(and(eq(schema.quoteSends.quoteId, quote.id), eq(schema.quoteSends.emailStatus, "sent")))
            .orderBy(desc(schema.quoteSends.id))
            .limit(1);
          const prior = last?.emailJson ? (JSON.parse(last.emailJson) as { to?: string; subject?: string; body?: string; cc?: string[] }) : null;
          const to = (prior?.to ?? last?.emailTo ?? "").trim();
          if (!prior?.subject || !prior.body || !to) return toOffice("it has never been emailed from Terra Ops, so there is no email to repeat");
          if (!recipients.some((r) => emailKey(r.email) === emailKey(to))) return toOffice("the address it went to is no longer on the quote's list");
          const sendKey = `retell:${ctx.call.retellCallId}:${quote.id}`;
          const row = await claimSend({ quote, sendKey, kind: "first", byName: AGENT_ACTOR.name });
          if (!row) return { ok: false, status: "uncertain", say: "I've already asked for that to go once on this call. I'll get the office to check it went.", needsPerson: "Quote resend asked twice, check it went", jobId: j.jobId };
          try {
            // The same checks the Send button runs.
            await assertBillable(quote.jobId);
            await assertReadyToGoOut(quote, AGENT_ACTOR);
            await recordPriceHistory(quote, AGENT_ACTOR.name);
          } catch (e) {
            await releaseSend(row.id);
            return toOffice(`it isn't ready to go out (${(e as Error).message})`);
          }
          const done = await runSend({ row, quote, who: { name: AGENT_ACTOR.name, role: AGENT_ACTOR.role, profileId: null }, email: { to, subject: prior.subject, body: prior.body }, sms: null });
          const ref = await quoteRefOf(quote);
          if (done.emailStatus === "sent") {
            return {
              ok: true,
              status: "done",
              // Sent means the mail service took it, not that it has arrived.
              say: "I've sent your quote to the email address we have on file. It usually arrives within a few minutes. If it isn't there soon, check your junk folder.",
              data: { quote_ref: ref, email: "sent to provider, delivery not confirmed" },
              entity: { type: "quote_send", id: done.id },
              jobId: j.jobId,
            };
          }
          const fu = await raise(ctx, "quote_resend_failed", "failure", `Quote ${ref} resend did not go`, `The agent tried to email quote ${ref} again and it failed: ${done.emailDetail ?? "no reason given"}.`, { jobId: j.jobId, priority: "high" });
          return { ok: false, status: "failed", say: FAILED_SAY, needsPerson: fu.row.title, jobId: j.jobId, entity: { type: "quote_send", id: done.id } };
        },
        failureHook(ctx, "resend_quote"),
      );
    },
  },

  check_quote_send_status: {
    action: "quoteResend",
    run: async (ctx) => {
      const j = await jobFor(ctx);
      if (!j.ok) return j.result;
      const { issued } = await currentQuotes(j.jobId);
      const ids = issued.map((q) => q.id);
      const [last] = ids.length ? await db.select().from(schema.quoteSends).where(inArray(schema.quoteSends.quoteId, ids)).orderBy(desc(schema.quoteSends.id)).limit(1) : [];
      const say = !last
        ? "I can't see that it has been sent yet."
        : last.emailStatus === "sent"
          ? "Our system shows it was sent to your email. I can't see whether it has arrived, so if it's not there, check your junk folder."
          : last.emailStatus === "failed"
            ? "It looks like the last email didn't go through. I'll get the office to fix that."
            : "It's still being sent.";
      const result: ToolResult = { ok: true, status: "done", say, data: { email: last?.emailStatus ?? "none", text: last?.smsStatus ?? "none", at: last?.emailAt ?? null } };
      await logRead(ctx.call, "check_quote_send_status", { job: j.jobId }, result);
      return result;
    },
  },

  request_callback: {
    action: "callback",
    run: async (ctx) => {
      const reason = str(ctx.args.reason, 800) || "Asked for a call back";
      const typeArg = str(ctx.args.call_type, 30) as CallType;
      const type: CallType = CALL_TYPES.includes(typeArg) ? typeArg : ctx.call.callType && CALL_TYPES.includes(ctx.call.callType as CallType) ? (ctx.call.callType as CallType) : "other";
      const urgent = yes(ctx.args.urgent) || type === "urgent";
      const number = str(ctx.args.callback_number, 40) || (ctx.call.withheld ? "" : (ctx.call.fromNumber ?? ""));
      if (!number && !ctx.call.verifiedContactId) return refuse("What's the best number to call you back on?", { needs: "callback_number" });
      return runAction(
        ctx.call,
        "request_callback",
        { type, urgent, reason },
        async () => {
          if (urgent) ctx.call = await patchCall(ctx.call.id, { priority: "urgent", callType: "urgent" });
          const when = str(ctx.args.best_time, 120);
          const fu = await raise(ctx, `callback:${type}`, urgent ? "urgent" : type, `Call back${urgent ? " (urgent)" : ""}: ${reason}`.slice(0, 200), [`Call back on ${number || "the number on file"}.`, when ? `Best time: ${when}.` : "", `Reason: ${reason}`].filter(Boolean).join(" "), { priority: urgent ? "urgent" : undefined });
          const open = inOfficeHours(ctx.cfg, ctx.now);
          return {
            ok: true,
            status: "done",
            say: urgent ? "I've flagged that as urgent and passed it straight to the team." : open ? "I've asked the team to call you back." : "The office is closed right now. I've asked the team to call you back when they're next in.",
            entity: { type: "followup", id: fu.row.id },
            needsPerson: fu.row.title,
          };
        },
        failureHook(ctx, "request_callback"),
      );
    },
  },

  /** Who a live transfer should ring. Separate from who owns the follow-up. */
  get_transfer_target: {
    action: "transfer",
    run: async (ctx) => {
      const typeArg = str(ctx.args.call_type, 30) as CallType;
      const type: CallType = CALL_TYPES.includes(typeArg) ? typeArg : "other";
      const t = ctx.cfg.transfers;
      let result: ToolResult;
      if (t.onlyInHours && !inOfficeHours(ctx.cfg, ctx.now)) {
        result = refuse("The office is closed, so I can't put you through. I'll take a message and have someone call you back.", { transfer: false, use: "request_callback" });
      } else {
        const dest = t.byCallType[type] ?? t.byCallType.other;
        const ids = dest ? await membersOf(ctx.cfg, dest, []) : [];
        let target: { name: string; number: string } | null = null;
        for (const id of ids) {
          // Someone on leave isn't rung: their cover is, when the cover has a number.
          const { person: p } = await settlePerson(id, localDate(ctx.now));
          const num = p?.phone ? (normaliseMobile(p.phone) ?? (phoneKey(p.phone) ? p.phone.replace(/[^\d+]/g, "") : null)) : null;
          if (p && p.active && !p.archived && num) {
            target = { name: p.name.split(" ")[0] ?? p.name, number: num };
            break;
          }
        }
        result = target
          ? { ok: true, status: "done", say: `I'll put you through to ${target.name} now.`, data: { transfer: true, number: target.number } }
          : refuse("I can't put you through right now. I'll take a message and have someone call you back.", { transfer: false, use: "request_callback" });
      }
      await logRead(ctx.call, "get_transfer_target", ctx.args, { ...result, data: { ...result.data, number: result.data?.number ? "(hidden)" : undefined } });
      return result;
    },
  },
};

/** Live install move. Single-day installs only, readiness and availability all clear. */
async function tryAutoMove(jobId: number, date: string): Promise<{ moved: true; taskId: number } | { moved: false; why: string }> {
  const live = await db
    .select()
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), inArray(schema.jobTasks.status, ["assigned"])));
  const installs = [];
  for (const t of live) if (!/measure|inspect|site visit/i.test(t.title)) installs.push(t);
  if (installs.length !== 1) return { moved: false, why: installs.length ? "more than one install task" : "no booked install task" };
  const task = installs[0]!;
  const days = await db.select().from(schema.taskDays).where(eq(schema.taskDays.taskId, task.id));
  if (days.length !== 1) return { moved: false, why: "the install runs over more than one day" };
  if (!task.assignedInstallerId || task.secondInstallerId) return { moved: false, why: "it has a second installer or nobody booked" };
  const block = await bookingBlock(task.id);
  if (block) return { moved: false, why: block };
  const [day] = await checkDays({ installerId: task.assignedInstallerId, dates: [date], exceptTaskId: task.id });
  if (!day || day.status !== "available" || day.clashes.length) return { moved: false, why: "the installer isn't free that day" };
  try {
    await bookTask({ taskId: task.id, installerId: task.assignedInstallerId, dates: [date], arrivalStart: days[0]!.arrivalStart, arrivalEnd: days[0]!.arrivalEnd, durationHours: task.durationHours, coordinateAfterFirst: false, perDay: [] }, AGENT_ACTOR);
  } catch (e) {
    return { moved: false, why: (e as Error).message.slice(0, 200) };
  }
  return { moved: true, taskId: task.id };
}

export const TOOL_NAMES = Object.keys(tools);

/**
 * Run one tool for one call. Always answers: a refusal or a failure comes back
 * as a result the agent can say, never as an error it would read out.
 */
export async function runTool(name: string, body: { call?: RetellCall; args?: Args }, now = new Date()): Promise<ToolResult> {
  const tool = tools[name];
  if (!tool) return refuse("I can't do that one. I'll get someone to call you back.", { unknown_tool: name });
  if (!body.call?.call_id) return refuse(FAILED_SAY, { error: "no call in the request" });
  const cfg = await loadPhoneConfig();
  if (!cfg.enabled) return refuse("I can't help with that one right now. Someone from the team will call you back.", { switched_off: true });
  if (tool.action && !cfg.actions[tool.action]) {
    return refuse(OFF_SAY, { action_off: tool.action, use: tool.action === "callback" ? undefined : "request_callback" });
  }
  const call = await upsertCall(body.call);
  const ctx: Ctx = { cfg, call, retell: body.call, args: body.args && typeof body.args === "object" ? body.args : {}, now };
  try {
    return await tool.run(ctx);
  } catch (e) {
    console.error(`[phone] tool ${name} failed:`, (e as Error).message);
    const fu = await raise(ctx, `error:${name}`, "failure", `AI call tool error: ${name.replace(/_/g, " ")}`, `The tool "${name}" errored on this call: ${(e as Error).message}. Nothing was confirmed to the caller.`, { priority: "high" }).catch(() => null);
    return { ok: false, status: "failed", say: FAILED_SAY, needsPerson: fu?.row.title };
  }
}
