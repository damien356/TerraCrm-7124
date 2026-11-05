import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import type { Actor } from "../../middleware/auth";
import { contactsByNumber, type CallRow } from "./caller";
import { phoneKey } from "../contact-merge";

/* ---------------------------------------------------------------------------
 * The call record and the actions on it (Retell, 5 Nov).
 *
 * One phone_calls row per Retell call_id, made by whichever arrives first: the
 * call_started webhook or the agent's first tool call.
 *
 * Every write the agent asks for goes through runAction():
 *   - the action is claimed by its idemKey before anything is written, so the
 *     same request twice (Retell retrying, the caller asking again) returns
 *     the first answer and never does it twice,
 *   - a claim still "running" when asked again means the first attempt is
 *     unaccounted for: the answer is "uncertain", never a guess,
 *   - an error is saved as "failed" with the reason, and the caller is told a
 *     person will follow it up. Nothing is ever said to be done before it is
 *     saved.
 * ------------------------------------------------------------------------- */

/** The made-up login every agent write is recorded under. Office level, never sees costs, can't approve anything. */
export const AGENT_ACTOR: Actor = {
  userId: "system:retell-agent",
  name: "AI phone agent",
  email: "",
  role: "office",
  installerId: null,
  canSeeCosts: false,
  profileId: null,
  isMainAdmin: false,
  canRestorePeople: false,
};

export type RetellCall = {
  call_id: string;
  agent_id?: string | null;
  direction?: string | null;
  from_number?: string | null;
  to_number?: string | null;
  start_timestamp?: number | null;
  end_timestamp?: number | null;
  duration_ms?: number | null;
  disconnection_reason?: string | null;
  transcript?: string | null;
  recording_url?: string | null;
  call_status?: string | null;
  call_analysis?: {
    call_summary?: string | null;
    user_sentiment?: string | null;
    call_successful?: boolean | null;
    in_voicemail?: boolean | null;
    custom_analysis_data?: Record<string, unknown> | null;
  } | null;
};

const isWithheld = (n: string | null | undefined) => !phoneKey(n) || /anonymous|private|unknown|restricted|withheld/i.test(n ?? "");

/** The call's row, made if this is the first we hear of it. Safe to call from two places at once. */
export async function upsertCall(c: RetellCall): Promise<CallRow> {
  const [found] = await db.select().from(schema.phoneCalls).where(eq(schema.phoneCalls.retellCallId, c.call_id));
  if (found) return found;
  // fromNumber is always the customer's side. On an outbound call (Terra's number ringing someone,
  // such as the test call from the Retell dashboard) that is the number rung, not Terra's own.
  const outbound = c.direction === "outbound";
  const customerNo = outbound ? c.to_number : c.from_number;
  const ourNo = outbound ? c.from_number : c.to_number;
  const withheld = outbound ? false : isWithheld(customerNo);
  const matched = withheld ? [] : await contactsByNumber(customerNo);
  await db
    .insert(schema.phoneCalls)
    .values({
      retellCallId: c.call_id,
      agentId: c.agent_id ?? null,
      direction: outbound ? "outbound" : "inbound",
      fromNumber: withheld ? null : (customerNo ?? null),
      toNumber: ourNo ?? null,
      withheld,
      startedAt: c.start_timestamp ? new Date(c.start_timestamp) : new Date(),
      matchedContactIds: JSON.stringify(matched),
    })
    .onConflictDoNothing();
  const [row] = await db.select().from(schema.phoneCalls).where(eq(schema.phoneCalls.retellCallId, c.call_id));
  return row!;
}

export async function callById(id: number) {
  const [row] = await db.select().from(schema.phoneCalls).where(eq(schema.phoneCalls.id, id));
  return row ?? null;
}

export async function patchCall(id: number, patch: Partial<typeof schema.phoneCalls.$inferInsert>) {
  const [row] = await db
    .update(schema.phoneCalls)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.phoneCalls.id, id))
    .returning();
  return row!;
}

export const matchedIds = (call: CallRow): number[] => {
  try {
    const v = JSON.parse(call.matchedContactIds) as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
};

/** A stable key for "the same request": same call, same tool, same arguments. */
/** JSON with keys sorted at every level, so the same args always hash the same. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function idemKeyFor(callId: string, name: string, args: unknown) {
  const stable = stableJson(args ?? {});
  return `${callId}:${name}:${createHash("sha256").update(stable).digest("hex").slice(0, 24)}`;
}

/** What every tool hands back to the agent. `say` is the plain line for the caller; the rest is for the agent. */
export type ToolResult = {
  ok: boolean;
  /** done: saved. refused: not allowed or not possible, nothing written. failed: error, nothing confirmed. uncertain: may or may not have happened. */
  status: "done" | "refused" | "failed" | "uncertain";
  say: string;
  data?: Record<string, unknown>;
  /** Work this leaves for a person. Becomes a follow-up. */
  needsPerson?: string;
};

export type ActionOutcome = ToolResult & {
  entity?: { type: string; id: number } | null;
  jobId?: number | null;
};

export const UNCERTAIN_SAY =
  "I can't confirm that one went through on my end, so I won't tell you it's done. I've flagged it and someone from the team will check and confirm with you.";
export const FAILED_SAY = "Sorry, I couldn't save that just now. I've passed it to the team and someone will follow it up with you.";

/**
 * Runs one write exactly once per idemKey. `fn` does the work and returns what
 * happened; it may throw. The outcome is stored before the agent hears it.
 */
export async function runAction(
  call: CallRow,
  name: string,
  args: Record<string, unknown>,
  fn: () => Promise<ActionOutcome>,
  opts: { onFailure?: (outcome: ActionOutcome, error: string) => Promise<void> } = {},
): Promise<ToolResult & { repeat?: boolean; actionId: number }> {
  const idemKey = idemKeyFor(call.retellCallId, name, args);
  const [claimed] = await db
    .insert(schema.phoneCallActions)
    .values({ callId: call.id, name, idemKey, args: JSON.stringify(args).slice(0, 8000), status: "running" })
    .onConflictDoNothing()
    .returning();

  if (!claimed) {
    const [prior] = await db.select().from(schema.phoneCallActions).where(eq(schema.phoneCallActions.idemKey, idemKey));
    if (prior && prior.status !== "running") {
      const stored = JSON.parse(prior.result || "{}") as ToolResult;
      return { ...stored, repeat: true, actionId: prior.id };
    }
    return { ok: false, status: "uncertain", say: "I'm still saving that from a moment ago. Give me a second.", repeat: true, actionId: prior?.id ?? 0 };
  }

  let outcome: ActionOutcome;
  let error: string | null = null;
  try {
    outcome = await fn();
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 500);
    console.error(`[phone] action ${name} on call ${call.id} failed:`, error);
    outcome = { ok: false, status: "failed", say: FAILED_SAY, needsPerson: `The agent tried "${name.replace(/_/g, " ")}" and it failed: ${error}` };
  }
  const { entity, jobId, ...result } = outcome;
  await db
    .update(schema.phoneCallActions)
    .set({
      status: result.status,
      result: JSON.stringify(result).slice(0, 20000),
      error,
      entityType: entity?.type ?? null,
      entityId: entity?.id ?? null,
      jobId: jobId ?? null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.phoneCallActions.id, claimed.id));
  if ((result.status === "failed" || result.status === "uncertain") && opts.onFailure) {
    try {
      await opts.onFailure(outcome, error ?? result.needsPerson ?? result.status);
    } catch (e) {
      console.error("[phone] failure follow-up not made:", (e as Error).message);
    }
  }
  return { ...result, actionId: claimed.id };
}

/** Plain record of a read the agent did, for the call history. Reads are not idempotent and need no claim. */
export async function logRead(call: CallRow, name: string, args: Record<string, unknown>, result: ToolResult) {
  await db.insert(schema.phoneCallActions).values({
    callId: call.id,
    name,
    idemKey: `${call.retellCallId}:${name}:read:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    args: JSON.stringify(args).slice(0, 8000),
    status: result.status,
    result: JSON.stringify(result).slice(0, 20000),
    finishedAt: new Date(),
  });
}

export async function actionsFor(callId: number) {
  return db.select().from(schema.phoneCallActions).where(eq(schema.phoneCallActions.callId, callId)).orderBy(schema.phoneCallActions.id);
}

/** Actions claimed but never finished after `olderThanMs`: the process died or the request was cut off. */
export async function staleRunning(olderThanMs: number, now = new Date()) {
  const cutoff = Math.floor((now.getTime() - olderThanMs) / 1000);
  return db
    .select()
    .from(schema.phoneCallActions)
    .where(and(eq(schema.phoneCallActions.status, "running"), sql`${schema.phoneCallActions.createdAt} < ${cutoff}`));
}

export async function markUncertain(actionId: number) {
  const [row] = await db
    .update(schema.phoneCallActions)
    .set({ status: "uncertain", result: JSON.stringify({ ok: false, status: "uncertain", say: UNCERTAIN_SAY }), finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.phoneCallActions.id, actionId), eq(schema.phoneCallActions.status, "running")))
    .returning();
  return row ?? null;
}

/** Note on the job's history from the agent. The same shape the job page's Add note writes. */
export async function jobNote(jobId: number, detail: string, action = "note", contactId: number | null = null) {
  const [row] = await db
    .insert(schema.activityLog)
    .values({ jobId, contactId, entityType: "job", entityId: jobId, action, detail: detail.slice(0, 4000), actorName: AGENT_ACTOR.name, actorRole: "system" })
    .returning({ id: schema.activityLog.id });
  return row!.id;
}

/** Audit line for phone work that isn't on a job: routing changes, follow-up ownership, call access. */
export async function audit(entityType: "phone_call" | "phone_followup" | "phone_routing" | "staff_cover", entityId: number | null, action: string, detail: string, actor: { name: string; role: string }, jobId: number | null = null) {
  await db.insert(schema.activityLog).values({ jobId, entityType, entityId, action, detail: detail.slice(0, 4000), actorName: actor.name, actorRole: actor.role });
}

/** The phone tables are made by 2026-11-25-phone-calls.sql. Until it runs, every phone screen and endpoint says so instead of erroring. */
const PHONE_TABLES = ["phone_calls", "phone_call_actions", "phone_followups", "phone_notifications", "staff_cover", "job_managers"];
export async function phoneTablesMissing(): Promise<string[]> {
  const rows = await db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`);
  const have = new Set(rows.map((r) => r.name));
  return PHONE_TABLES.filter((t) => !have.has(t));
}
