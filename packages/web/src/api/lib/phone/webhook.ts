import { and, eq, isNotNull, isNull, lt, ne, inArray } from "drizzle-orm";
import { localDate } from "../local-date";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { jobText } from "../refs";
import { actionsFor, audit, callById, markUncertain, patchCall, staleRunning, upsertCall, type RetellCall } from "./calls";
import { CALL_TYPES, CALL_TYPE_LABELS, inOfficeHours, loadPhoneConfig, ruleFor, type CallType, type PhoneConfig } from "./config";
import { createFollowup, followupPath, moveOpenWork, sayWhen } from "./followups";
import { notifyPhone } from "./notify";
import { coverFor, resolveRoute, settlePerson } from "./routing";

/* ---------------------------------------------------------------------------
 * Retell's webhooks, and closing out a call (Retell, 5 Nov).
 *
 *   call_started   the call row is made,
 *   call_ended     times, transcript, recording, why it ended. What the agent
 *                  already saved stays saved. Anything unfinished becomes work,
 *   call_analyzed  the summary. The call is finalised: one outcome
 *                  notification, and a follow-up only when work remains.
 * When the analysis never arrives the sweep finalises the call anyway, so a
 * hang-up or a lost webhook never loses the outcome.
 * ------------------------------------------------------------------------- */

export type RetellEvent = { event?: string; call?: RetellCall };

export async function handleRetellEvent(body: RetellEvent, now = new Date()) {
  const ev = body.event ?? "";
  const c = body.call;
  if (!c?.call_id) return { handled: false, reason: "no call" };
  const call = await upsertCall(c);

  if (ev === "call_started") return { handled: true, callId: call.id };

  if (ev === "call_ended") {
    await patchCall(call.id, {
      status: call.status === "finalised" ? "finalised" : "ended",
      endedAt: c.end_timestamp ? new Date(c.end_timestamp) : now,
      durationSec: c.duration_ms != null ? Math.round(c.duration_ms / 1000) : c.end_timestamp && c.start_timestamp ? Math.round((c.end_timestamp - c.start_timestamp) / 1000) : null,
      disconnectionReason: c.disconnection_reason ?? null,
      transcript: c.transcript ?? call.transcript,
      recordingUrl: c.recording_url ?? call.recordingUrl,
    });
    // Anything still marked running when the line dropped can't be vouched for: a person checks it.
    const running = (await actionsFor(call.id)).filter((a) => a.status === "running");
    if (running.length) {
      const cfg = await loadPhoneConfig();
      for (const a of running) {
        if (await markUncertain(a.id)) await raiseUncertain(cfg, a, call, now, `The line dropped while the agent was doing "${a.name}". Check whether it happened and confirm with the caller.`);
      }
    }
    return { handled: true, callId: call.id };
  }

  if (ev === "call_analyzed") {
    const a = c.call_analysis ?? {};
    await patchCall(call.id, {
      summary: (a.call_summary ?? "").slice(0, 4000),
      sentiment: a.user_sentiment ?? null,
      analysisState: "done",
      transcript: c.transcript ?? call.transcript,
      recordingUrl: c.recording_url ?? call.recordingUrl,
      ...(call.endedAt ? {} : { endedAt: c.end_timestamp ? new Date(c.end_timestamp) : now }),
    });
    await finaliseCall(call.id, { analysis: a.custom_analysis_data ?? null, now });
    return { handled: true, callId: call.id };
  }

  if (ev.startsWith("transfer_")) {
    await audit("phone_call", call.id, ev, `Live transfer: ${ev.replace("transfer_", "")}`, { name: "Retell", role: "system" }, call.jobId);
    if (ev === "transfer_cancelled" || ev === "transfer_failed") {
      const cfg = await loadPhoneConfig();
      if (cfg.transfers.noAnswerCallback) {
        await createFollowup(cfg, {
          dedupeKey: `call:${call.id}:transfer_no_answer`,
          callType: (CALL_TYPES as readonly string[]).includes(call.callType) ? (call.callType as CallType) : "other",
          title: "Transfer not answered: call back",
          detail: `The agent tried to put the caller through and nobody answered. Call back on ${call.withheld ? "the number they gave" : (call.fromNumber ?? "the number on file")}.`,
          callId: call.id,
          jobId: call.jobId,
          contactId: call.contactId,
          now,
        });
      }
    }
    return { handled: true, callId: call.id };
  }

  // transcript_updated and anything new: the row exists, nothing else to do.
  return { handled: true, callId: call.id, ignored: ev };
}

const FRIENDLY: Record<string, string> = {
  create_enquiry: "Enquiry saved",
  add_call_note: "Note added to the job",
  update_job_details: "Access details updated",
  book_visit: "Visit booked",
  request_install_change: "Install change passed to scheduling",
  resend_quote: "Quote resent",
  request_callback: "Call back requested",
  verify_caller: "Caller verified",
};

/** The outcome line for one done action. A quote the agent couldn't send went to the office, so it must not say "Quote resent". */
export function friendlyOf(a: { name: string; result: string | null }) {
  if (a.name === "resend_quote") {
    try {
      const r = JSON.parse(a.result || "{}") as { entity?: { type?: string } };
      if (r.entity?.type !== "quote_send") return "Quote request passed to the office";
    } catch {
      return "Quote request passed to the office";
    }
  }
  return FRIENDLY[a.name]!;
}

/**
 * One outcome per call: what was done, what still needs a person, and who
 * has it. Safe to run twice: the second run does nothing.
 */
export async function finaliseCall(callId: number, opts: { analysis?: Record<string, unknown> | null; now?: Date; missing?: boolean } = {}) {
  const now = opts.now ?? new Date();
  // Claim the finalise so a webhook and the sweep can't both send it.
  const [claimed] = await db
    .update(schema.phoneCalls)
    .set({ finalisedAt: now, status: "finalised", ...(opts.missing ? { analysisState: "missing" } : {}), updatedAt: now })
    .where(and(eq(schema.phoneCalls.id, callId), isNull(schema.phoneCalls.finalisedAt)))
    .returning();
  if (!claimed) return { finalised: false };
  const call = claimed;
  const cfg = await loadPhoneConfig();
  const acts = await actionsFor(callId);
  const writes = acts.filter((a) => FRIENDLY[a.name]);

  const done = writes.filter((a) => a.status === "done").map(friendlyOf);
  const notDone: string[] = [];
  const failures: string[] = [];
  for (const a of acts) {
    if (a.status === "failed" || a.status === "uncertain") failures.push(`${a.name.replace(/_/g, " ")} ${a.status === "failed" ? "failed" : "not confirmed"}`);
    try {
      const r = JSON.parse(a.result || "{}") as { needsPerson?: string };
      if (r.needsPerson && a.status !== "failed" && a.status !== "uncertain") notDone.push(r.needsPerson);
    } catch {
      /* unreadable result: nothing to add */
    }
  }

  const ad = opts.analysis ?? {};
  const askedType = typeof ad.call_type === "string" ? (ad.call_type as string) : "";
  let type: CallType = (CALL_TYPES as readonly string[]).includes(askedType) ? (askedType as CallType) : (call.callType as CallType);
  const urgent = ad.urgent === true || call.priority === "urgent" || type === "urgent";
  if (urgent) type = "urgent";
  const unresolved = typeof ad.unresolved_request === "string" ? ad.unresolved_request.trim() : "";
  // The analysis says something is left that no tool caught.
  if (unresolved && !notDone.length) notDone.push(unresolved);
  // Hung up with nothing saved and no enquiry or verification: someone should ring back.
  // A failed or unconfirmed action already raised its own follow-up to check with the caller, so not twice.
  const dropped = !done.length && !call.jobId && !call.verifiedContactId && (call.durationSec ?? 0) >= 20 && !call.withheld;
  if (dropped && !notDone.length && !failures.length) notDone.push("Call ended before anything was done. Ring back.");
  if (opts.missing && !notDone.length && !done.length && !failures.length) notDone.push("No summary came from Retell. Check the call.");

  const outcome = done.length ? done.join(". ") : "Nothing saved";
  const needsPerson = [...new Set([...failures, ...notDone])].join(" | ");
  const [job] = call.jobId ? await db.select().from(schema.jobs).where(eq(schema.jobs.id, call.jobId)) : [];
  const [person] = call.contactId ? await db.select({ f: schema.contacts.firstName, l: schema.contacts.lastName }).from(schema.contacts).where(eq(schema.contacts.id, call.contactId)) : [];
  const who = person ? `${person.f ?? ""} ${person.l ?? ""}`.trim() : "Unknown caller";
  const num = call.withheld ? "number withheld" : (call.fromNumber ?? "no number");
  const about = call.newEnquiry ? `New enquiry${job ? ` (job ${jobText(job)})` : ""}` : job ? `Job ${jobText(job)}` : "No job";

  await patchCall(callId, { callType: type, priority: urgent ? "urgent" : call.priority, outcome: outcome.slice(0, 1000), needsPerson: needsPerson.slice(0, 2000) });

  const path = `/phone-calls/${callId}`;
  let fuId: number | null = null;
  // Open follow-ups this call already raised mid-call (failures, callbacks, install changes) count as the work.
  // Failed actions raised their own urgent follow-up the moment they failed.
  const already = await db
    .select({ id: schema.phoneFollowups.id, title: schema.phoneFollowups.title })
    .from(schema.phoneFollowups)
    .where(and(eq(schema.phoneFollowups.callId, callId), ne(schema.phoneFollowups.status, "resolved")));
  const titles = new Set(already.map((f) => f.title));
  const leftOver = [...new Set(notDone)].filter((n) => !titles.has(n));
  if (leftOver.length) {
    const fu = await createFollowup(cfg, {
      dedupeKey: `call:${callId}:final`,
      callType: type,
      title: `${who}: ${leftOver[0]!}`.slice(0, 200),
      detail: [`${about}. ${num}.`, call.summary ? `Summary: ${call.summary}` : "", `Done on the call: ${outcome}.`, `Still needs a person: ${leftOver.join(" | ")}`].filter(Boolean).join("\n"),
      callId,
      jobId: call.jobId,
      contactId: call.contactId,
      priority: urgent ? "urgent" : undefined,
      callerLine: `${who}, ${num}`,
      now,
    });
    fuId = fu.row.id;
  }

  // The outcome itself. Skipped when a follow-up just told the owner, so nobody gets two pings for one call.
  if (!fuId && (cfg.notifyEveryCall || urgent)) {
    const route = await resolveRoute(cfg, type, { jobId: call.jobId, now });
    const rule = ruleFor(cfg, type);
    if (route.ownerProfileId) await patchCall(callId, { ownerProfileId: route.ownerProfileId });
    const left = already.length ? ` ${already.length} follow-up${already.length === 1 ? "" : "s"} open.` : "";
    await notifyPhone(
      cfg,
      route.ownerProfileId,
      {
        kind: urgent ? "phone_urgent" : "phone_call",
        reason: "outcome",
        title: `${urgent ? "URGENT " : ""}AI call: ${who}, ${about}`.slice(0, 140),
        body: `${CALL_TYPE_LABELS[type]}. ${outcome}.${left}${inOfficeHours(cfg, now) ? "" : " (after hours)"}`.slice(0, 300),
        path,
        callId,
        jobId: call.jobId,
        urgent,
      },
      urgent ? rule.channels : ["in_app"],
    );
  }
  return { finalised: true, followupId: fuId, outcome, needsPerson };
}

/* --------------------------------- sweep --------------------------------- */

const MIN = 60_000;
/** A claimed action not finished after this is treated as unknown. */
export const STALE_ACTION_MS = 2 * MIN;
/** Ended calls get this long for the analysis before they are finalised without it. */
export const ANALYSIS_WAIT_MS = 10 * MIN;
/** A call that never sent call_ended. */
export const LOST_CALL_MS = 3 * 60 * MIN;

async function overdueWork(cfg: PhoneConfig, now: Date) {
  const open = await db
    .select()
    .from(schema.phoneFollowups)
    .where(and(inArray(schema.phoneFollowups.status, ["new", "assigned", "in_progress"]), lt(schema.phoneFollowups.escalationLevel, 1)));
  let reminded = 0;
  let escalated = 0;
  const officeOpen = inOfficeHours(cfg, now);
  for (const fu of open) {
    if (!fu.dueAt) continue;
    const urgent = fu.priority === "urgent";
    // Non-urgent work is only chased while the office is open.
    if (!urgent && !officeOpen) continue;
    const due = fu.dueAt.getTime();
    const remindAt = due - cfg.reminderBeforeEscalateMins * MIN;
    const rule = ruleFor(cfg, fu.callType as CallType);
    if (now.getTime() >= due) {
      const [took] = await db
        .update(schema.phoneFollowups)
        .set({ escalatedAt: now, escalationLevel: 1, updatedAt: now })
        .where(and(eq(schema.phoneFollowups.id, fu.id), lt(schema.phoneFollowups.escalationLevel, 1)))
        .returning();
      if (!took) continue;
      const target = rule.escalateTo ? await resolveRoute(cfg, fu.callType as CallType, { dest: rule.escalateTo, now, exclude: fu.ownerProfileId ? [fu.ownerProfileId] : [] }) : null;
      await audit("phone_followup", fu.id, "followup_escalated", `Past its deadline (${sayWhen(fu.dueAt)}). Escalated to ${target?.ownerName || "the queue"}. ${target?.steps.join(" ") ?? ""}`, { name: "Terra Ops", role: "system" }, fu.jobId);
      // Nobody owned it: the escalation person becomes the owner. Otherwise the owner keeps it and is chased.
      if (!fu.ownerProfileId && target?.ownerProfileId) {
        await db.update(schema.phoneFollowups).set({ ownerProfileId: target.ownerProfileId, ownerName: target.ownerName, status: "assigned", routedVia: "escalation", updatedAt: now }).where(eq(schema.phoneFollowups.id, fu.id));
      }
      const notice = { kind: "phone_escalated" as const, reason: "escalation" as const, title: `Overdue call follow-up: ${fu.title}`.slice(0, 140), body: `Was due ${sayWhen(fu.dueAt)}. Owner: ${fu.ownerName || "nobody"}.`, path: followupPath(fu.id), followupId: fu.id, callId: fu.callId, jobId: fu.jobId, urgent: true };
      await notifyPhone(cfg, target?.ownerProfileId ?? null, notice, ["in_app", "push", "email"]);
      if (fu.ownerProfileId) await notifyPhone(cfg, fu.ownerProfileId, { ...notice, reason: "reminder" }, ["in_app", "push"]);
      escalated++;
    } else if (!fu.remindedAt && now.getTime() >= remindAt && cfg.reminderBeforeEscalateMins > 0) {
      const [took] = await db
        .update(schema.phoneFollowups)
        .set({ remindedAt: now, updatedAt: now })
        .where(and(eq(schema.phoneFollowups.id, fu.id), isNull(schema.phoneFollowups.remindedAt)))
        .returning();
      if (!took) continue;
      await notifyPhone(
        cfg,
        fu.ownerProfileId,
        { kind: "phone_followup", reason: "reminder", title: `Due soon: ${fu.title}`.slice(0, 140), body: `Due ${sayWhen(fu.dueAt)}. It escalates after that.`, path: followupPath(fu.id), followupId: fu.id, callId: fu.callId, jobId: fu.jobId, urgent },
        rule.channels,
      );
      reminded++;
    }
  }
  return { reminded, escalated };
}

/**
 * Leave that has started (set earlier for a later date): the person's open
 * work moves to whoever covers them, deadlines kept. Leave set for today
 * moves it straight away from the screen; this catches the rest.
 */
async function coverMoves(cfg: PhoneConfig, now: Date) {
  const today = localDate(now);
  const owners = await db
    .selectDistinct({ id: schema.phoneFollowups.ownerProfileId })
    .from(schema.phoneFollowups)
    .where(and(ne(schema.phoneFollowups.status, "resolved"), isNotNull(schema.phoneFollowups.ownerProfileId)));
  let moved = 0;
  for (const o of owners) {
    const cover = await coverFor(o.id!, today);
    if (!cover) continue;
    const { person } = await settlePerson(cover.coverProfileId, today);
    if (!person || person.id === o.id) continue;
    moved += await moveOpenWork(cfg, o.id!, person.id, { name: "Terra Ops", role: "system", profileId: null }, `${cover.kind === "leave" ? "Leave cover" : "Delegation"} from ${cover.fromDate}.`);
  }
  return moved;
}

/** An action nobody can vouch for becomes high-priority work, once per action name per call. */
async function raiseUncertain(
  cfg: PhoneConfig,
  a: { name: string; jobId: number | null },
  call: { id: number; jobId: number | null; contactId: number | null },
  now: Date,
  detail: string,
) {
  await createFollowup(cfg, {
    dedupeKey: `call:${call.id}:failure:${a.name}`,
    callType: "failure",
    title: `AI call action not confirmed: ${a.name.replace(/_/g, " ")}`,
    detail,
    callId: call.id,
    jobId: a.jobId ?? call.jobId,
    contactId: call.contactId,
    priority: "high",
    now,
  });
}

/** One pass. The timer runs it every minute on the live server; the tests call it directly. */
export async function sweepOnce(now = new Date()) {
  const out = { uncertain: 0, finalised: 0, reminded: 0, escalated: 0, coverMoved: 0 };
  const cfg = await loadPhoneConfig();

  for (const a of await staleRunning(STALE_ACTION_MS, now)) {
    const row = await markUncertain(a.id);
    if (!row) continue;
    out.uncertain++;
    const call = await callById(a.callId);
    if (call) await raiseUncertain(cfg, a, call, now, `The agent started "${a.name}" and it never finished. Check whether it happened and confirm with the caller.`);
  }

  const waiting = await db
    .select({ id: schema.phoneCalls.id, status: schema.phoneCalls.status, endedAt: schema.phoneCalls.endedAt, startedAt: schema.phoneCalls.startedAt })
    .from(schema.phoneCalls)
    .where(and(isNull(schema.phoneCalls.finalisedAt), inArray(schema.phoneCalls.status, ["live", "ended"])));
  for (const c of waiting) {
    const ended = c.status === "ended" && c.endedAt && now.getTime() - c.endedAt.getTime() >= ANALYSIS_WAIT_MS;
    const lost = c.status === "live" && c.startedAt && now.getTime() - c.startedAt.getTime() >= LOST_CALL_MS;
    if (ended || lost) {
      const r = await finaliseCall(c.id, { now, missing: true });
      if (r.finalised) out.finalised++;
    }
  }

  out.coverMoved = await coverMoves(cfg, now);

  // Open work is chased even with the agent switched off.
  const r = await overdueWork(cfg, now);
  out.reminded = r.reminded;
  out.escalated = r.escalated;
  return out;
}
