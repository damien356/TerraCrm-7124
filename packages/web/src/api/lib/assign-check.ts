import { asc, eq, inArray } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { missingSkills, sayList, skillsForTask } from "./task-skills";
import { lockedItems } from "./rate-access";
import { termsFor, termsOn } from "./hourly";
import { unsetPayLines, unsetRates } from "./line-rates";
import { todayLocal } from "./local-date";
import { rateBook } from "../routes/labour";

/* ---------------------------------------------------------------------------
 * Assign anyway (Damien, 11 Nov 2026, dispatch 188007-A).
 *
 * The cause: 188007-A carries two day-rate lines, "Day rate, one man" and
 * "Day rate, leading hand". Both are per-person items (7 Nov rule), switched
 * on for nobody, so every active person was refused, Pedro Sinclair included.
 * Pedro is paid hourly: for him those lines are only Terra's benchmark (the
 * pay is his approved hours), so the lock was never about his pay.
 *
 * Now a missing work-category tick, a per-person item not switched on, and a
 * missing rate are warnings, not stops. The office sees the exact names and
 * the reason, and can press Assign anyway. The server works the warnings out
 * again and only saves when every one of them was acknowledged for that
 * person. The override is written on the job history with the warning, who
 * confirmed it, when, and the optional note. Nothing on the person's profile,
 * skills or pay terms is changed.
 *
 * A missing rate is Pay to confirm: booked, flagged for the office, and never
 * paid, invoiced or approved until the rate is set (those checks stay).
 *
 * Still stops: archived or switched off, a dispatch with no lines and no pay
 * at all (Pay not set, 10 Nov), calendar checks, replacing someone, outside
 * hours confirms, and access permissions.
 * ------------------------------------------------------------------------- */

export const ASSIGN_CHECK = "assign_check";
export const PAY_TO_CONFIRM = "Pay to confirm";

export type AssignWarning = {
  kind: "skill" | "rate_item" | "rate_not_set" | "hourly_rate_not_set";
  /** The exact words acknowledged. Compared as they are. */
  text: string;
  /** Why it matters, shown under the warning. */
  detail: string;
};

export type PayMethod = {
  kind: "hourly" | "employee" | "staff" | "fixed";
  label: string;
  /** Only filled for people who may see installer rates. */
  rate: string | null;
  payToConfirm: boolean;
};

/** What the office sends after pressing Assign anyway, one per person. */
export const assignAnywayInput = z
  .array(
    z.object({
      installerId: z.number(),
      warnings: z.array(z.string().max(600)).max(20),
      note: z.string().trim().max(500).nullable().optional(),
    }),
  )
  .max(10)
  .optional();
export type AssignAnyway = z.infer<typeof assignAnywayInput>;

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const quoted = (names: string[]) => sayList(names.map((n) => `"${n}"`));
const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2 });

/** How this person is paid, said plainly. Rates only for those allowed to see them. */
export async function payMethodOf(installerId: number, showRates: boolean, on: string = todayLocal()): Promise<PayMethod> {
  const [person] = await db.select({ workerType: schema.installers.workerType }).from(schema.installers).where(eq(schema.installers.id, installerId));
  const terms = await termsOn(installerId, on);
  if (terms?.defaultForNew) {
    const set = terms.baseRate > 0;
    const extras = [terms.weekendMultiplier !== 1 ? `weekend ×${terms.weekendMultiplier}` : null, terms.nightMultiplier !== 1 ? `night ×${terms.nightMultiplier}` : null].filter(Boolean);
    return {
      kind: "hourly",
      label: set ? "Hourly, paid on approved hours" : `Hourly, rate not set: ${PAY_TO_CONFIRM}`,
      rate: showRates && set ? `${money(terms.baseRate)} an hour${extras.length ? ` (${extras.join(", ")})` : ""}` : null,
      payToConfirm: !set,
    };
  }
  if (person?.workerType === "employee") return { kind: "employee", label: "Employee, paid wages", rate: null, payToConfirm: false };
  const [card] = await db.select({ id: schema.staffCards.id }).from(schema.staffCards).where(eq(schema.staffCards.installerId, installerId));
  if (card) return { kind: "staff", label: "Staff card, paid wages", rate: null, payToConfirm: false };
  return { kind: "fixed", label: "Fixed price, off the rate book lines", rate: null, payToConfirm: false };
}

/** The same words wherever the warning shows: the picker, the confirm and the job history. */
export const warningText = {
  skill(names: string[], name: string): AssignWarning {
    const who = firstName(name);
    return {
      kind: "skill",
      text: `${quoted(names)} ${names.length === 1 ? "is" : "are"} not ticked on ${who}'s profile.`,
      detail: "This work category isn't ticked for them. Check they can do it. Their profile is not changed.",
    };
  },
  rateItem(names: string[], name: string, hourly: boolean, ownRates = false): AssignWarning {
    const who = firstName(name);
    const one = names.length === 1;
    return {
      kind: "rate_item",
      text: `${quoted(names)} ${one ? "is" : "are"} not enabled on ${who}'s profile.`,
      detail: hourly
        ? `${who} is paid hourly, so ${one ? "this line is" : "these lines are"} only Terra's benchmark for the dispatch. The pay is ${who}'s approved hours.`
        : ownRates
          ? `${who}'s own agreed rate on the card is used for ${one ? "this line" : "these lines"}. Terra's rate is not borrowed.`
          : `There is no agreed rate for ${one ? "this line" : "these lines"} on ${who}'s card, so ${one ? "it shows" : "they show"} ${PAY_TO_CONFIRM} until the office sets it. Terra's rate is not borrowed.`,
    };
  },
  hourlyRate(name: string): AssignWarning {
    return {
      kind: "hourly_rate_not_set",
      text: `${PAY_TO_CONFIRM}: no hourly rate is set for ${firstName(name)}.`,
      detail: "The booking is flagged for the office. No time is approved or paid until the hourly rate is set.",
    };
  },
  lineRate(names: string[], name: string): AssignWarning {
    return {
      kind: "rate_not_set",
      text: `${PAY_TO_CONFIRM}: ${quoted(names)} ${names.length === 1 ? "has" : "have"} no rate for ${firstName(name)} (Rate not set).`,
      detail: "The booking is flagged for the office. Nothing is paid, invoiced or approved at $0.00. Set the rate, then lock the labour again.",
    };
  },
};

/**
 * The warnings for giving these lines of a task (all lines when itemIds is
 * left out) to this person. Empty means nothing to confirm.
 * typedPay: an amount the office is giving now, which settles the rate.
 */
export async function assignWarnings(
  taskId: number,
  installerId: number,
  itemIds?: number[] | null,
  opts: { typedPay?: number | null; on?: string } = {},
): Promise<AssignWarning[]> {
  const on = opts.on ?? todayLocal();
  const [person] = await db.select({ name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, installerId));
  if (!person) return [];
  const terms = await termsOn(installerId, on);
  const hourly = Boolean(terms?.defaultForNew);
  const out: AssignWarning[] = [];

  const missing = await missingSkills(installerId, await skillsForTask(taskId, itemIds));
  if (missing.length) out.push(warningText.skill(missing.map((m) => m.name), person.name));

  const lines = await db.select({ itemId: schema.taskLabourLines.itemId }).from(schema.taskLabourLines).where(eq(schema.taskLabourLines.taskId, taskId));
  const ids = lines.map((l) => l.itemId).filter((id) => !itemIds?.length || itemIds.includes(id));
  const locked = (await lockedItems(installerId, ids, on)).sort((a, b) => a.id - b.id);
  if (locked.length) {
    // His own agreed rate still counts; Terra's standard is never borrowed for these (costing priceLines).
    const rates = hourly ? [] : await rateBook.loadRates(locked.map((l) => l.id));
    const ownRates = !hourly && locked.every((l) => {
      const r = rateBook.pick(rates, l.id, installerId, on);
      return r.source === "installer" && (r.amount ?? 0) > 0;
    });
    out.push(warningText.rateItem(locked.map((l) => l.name), person.name, hourly, ownRates));
  }

  if (opts.typedPay == null) {
    if (hourly && !(terms!.baseRate > 0)) out.push(warningText.hourlyRate(person.name));
    else if (!hourly) {
      const lockedIds = new Set(locked.map((l) => l.id));
      const unset = (await unsetRates(taskId, installerId, itemIds, on)).filter((u) => !lockedIds.has(u.itemId));
      if (unset.length) out.push(warningText.lineRate(unset.map((u) => u.name), person.name));
    }
  }
  return out;
}

/** Refuses with the warnings unless every one was acknowledged for this person. */
export function requireAcknowledged(args: {
  installerId: number;
  name: string;
  warnings: AssignWarning[];
  ack: AssignAnyway;
  payMethod: PayMethod;
}) {
  if (!args.warnings.length) return null;
  const mine = args.ack?.find((a) => a.installerId === args.installerId);
  const done = mine && args.warnings.every((w) => mine.warnings.includes(w.text));
  if (done) return { note: mine!.note?.trim() || null };
  throw new ORPCError("BAD_REQUEST", {
    message: `Check assignment — ${args.name}. ${args.warnings.map((w) => w.text).join(" ")}`,
    data: { reason: ASSIGN_CHECK, installerId: args.installerId, name: args.name, warnings: args.warnings, payMethod: args.payMethod },
  });
}

/** The override on the job history: the warning, who confirmed it, when, and the note. */
export async function logAssignOverride(args: {
  jobId: number;
  taskId: number;
  taskRef: string;
  installerName: string;
  warnings: AssignWarning[];
  note: string | null;
  actor: Actor;
  source: string;
}) {
  if (!args.warnings.length) return;
  const at = new Date().toLocaleString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  await db.insert(schema.activityLog).values({
    jobId: args.jobId,
    taskId: args.taskId,
    entityType: "task",
    entityId: args.taskId,
    action: "assignment_override",
    detail: `Assign anyway: ${args.installerName} on ${args.taskRef} (${args.source}). Warning: ${args.warnings.map((w) => w.text).join(" ")} Confirmed by ${args.actor.name} (${args.actor.role}) on ${at}.${args.note ? ` Note: ${args.note}` : ""}`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
}

/**
 * The Assign anyway records on each task for the people on it now, newest
 * last, for the booking panel when it is reopened.
 */
export async function overridesFor(tasks: Array<{ id: number; names: string[] }>) {
  const out = new Map<number, Array<{ detail: string; by: string; at: Date }>>();
  if (!tasks.length) return out;
  const rows = await db
    .select()
    .from(schema.activityLog)
    .where(inArray(schema.activityLog.taskId, [...new Set(tasks.map((t) => t.id))]))
    .orderBy(asc(schema.activityLog.id));
  for (const t of tasks) {
    const mine = rows.filter(
      (r) => r.taskId === t.id && r.action === "assignment_override" && t.names.some((n) => r.detail.startsWith(`Assign anyway: ${n} on `)),
    );
    if (mine.length) out.set(t.id, mine.map((r) => ({ detail: r.detail, by: r.actorName, at: r.createdAt })));
  }
  return out;
}

/**
 * Booked dispatches whose pay still has to be confirmed: hourly with no rate
 * agreed, or fixed-price lines with no rate. Read only, for the office flag.
 */
export async function payToConfirmTaskIds(taskIds: number[], on: string = todayLocal()): Promise<Set<number>> {
  const ids = [...new Set(taskIds)];
  const out = new Set<number>();
  if (!ids.length) return out;
  const tasks = await db
    .select({
      id: schema.jobTasks.id,
      status: schema.jobTasks.status,
      installerId: schema.jobTasks.assignedInstallerId,
      payType: schema.jobTasks.payType,
      payAmount: schema.jobTasks.payAmount,
      agreedHourlyRate: schema.jobTasks.agreedHourlyRate,
      labourBreakdown: schema.jobTasks.labourBreakdown,
    })
    .from(schema.jobTasks)
    .where(inArray(schema.jobTasks.id, ids));
  const live = tasks.filter((t) => t.installerId != null && t.status !== "cancelled" && t.status !== "complete");
  const terms = await termsFor(live.map((t) => t.installerId!), on);
  for (const t of live) {
    if (t.payType === "hourly") {
      if (t.agreedHourlyRate != null && t.agreedHourlyRate > 0) continue;
      const now = terms.get(t.installerId!);
      if (!(now && now.baseRate > 0)) out.add(t.id);
      else if (t.agreedHourlyRate != null) out.add(t.id);
      continue;
    }
    if (t.payAmount != null || !t.labourBreakdown) continue;
    try {
      const lines = JSON.parse(t.labourBreakdown) as Array<{ name: string; qty: number; rate: number | null; total: number | null }>;
      if (unsetPayLines(lines).length) out.add(t.id);
    } catch {
      /* unreadable: left to the other checks */
    }
  }
  return out;
}
