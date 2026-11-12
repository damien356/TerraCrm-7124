import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { round2 } from "./hourly-calc";
import { RATE_TO_CONFIRM, crewSessionView, isHourlyContractor, ownRatesView, taskPay, taskRatesView, termsOn, viewSessions } from "./hourly";

/**
 * WHAT AN HOURLY CONTRACTOR'S PHONE IS ALLOWED TO RECEIVE.
 *
 * An hourly man sees his own hourly rates, his own time and his own pay. He
 * never receives a per-unit rate schedule (carpet, timber, anything per m2 or
 * per lin), a subcontract benchmark, the vehicle allowance, a margin or anyone
 * else's rate. That is enforced here, on the server, for every hourly
 * contractor, not only Pedro, and not in the app.
 *
 * Every function is a no-op for a normal per-unit installer, so their screens
 * are unchanged. Responses stay the same shape, with an extra `hourly` field,
 * so phone builds 13, 14 and 15 keep working: an hourly task reads as
 * "$47 /hr" on an old build because payAmount is his ordinary hourly rate and
 * there is no breakdown.
 *
 * Damien, 11 Nov 2026: the rate shown is the one agreed for THAT task (or his
 * terms when none was copied onto it). With no agreed rate, or $0, payAmount
 * is null and payNote reads "Rate to confirm": never the standard $50, never
 * $0.00.
 */

export type CrewHourly = Awaited<ReturnType<typeof crewHourlyContext>>;

/** Null for a per-unit installer. For an hourly man, his rates and his time per task. */
export async function crewHourlyContext(installerId: number, taskIds: number[] = [], force = false) {
  if (!force && !(await isHourlyContractor(installerId))) return null;
  const terms = await termsOn(installerId);
  const rates = ownRatesView(terms);
  const ids = [...new Set(taskIds)];
  const views = ids.length
    ? await viewSessions(
        and(
          eq(schema.workSessions.installerId, installerId),
          inArray(schema.workSessions.taskId, ids),
          sql`${schema.workSessions.status} != 'rejected'`,
        ),
      )
    : [];
  const perTask = new Map<number, ReturnType<typeof timeOf>>();
  for (const id of ids) perTask.set(id, timeOf(views.filter((v) => v.taskId === id)));
  const pay = await taskPay(ids);
  const taskRates = new Map<number, ReturnType<typeof taskRatesView>>();
  for (const id of ids) taskRates.set(id, taskRatesView(terms, pay.get(id)));
  return { rates, gstRegistered: Boolean(terms?.gstRegistered), perTask, taskRates };
}

function timeOf(views: Awaited<ReturnType<typeof viewSessions>>) {
  const approved = views.filter((v) => v.status === "approved");
  const notYet = views.filter((v) => v.status !== "approved");
  return {
    approvedMinutes: approved.reduce((a, v) => a + (v.approvedMinutes ?? 0), 0),
    approvedPay: round2(approved.reduce((a, v) => a + (v.approvedPay ?? 0), 0)),
    recordedMinutes: notYet.reduce((a, v) => a + v.payableMinutes, 0),
    open: notYet.filter((v) => v.status === "open").map(crewSessionView)[0] ?? null,
    sessions: views.map(crewSessionView),
  };
}

type CardLike = {
  id: number;
  payType: string;
  payAmount: number | null;
  payNote?: string | null;
  labourCost?: number | null;
  payBreakdown?: unknown;
  payTotal?: number | null;
  gstRegistered?: boolean;
};

/** One task card or task detail, cut down for an hourly man. */
export function redactCard<T extends CardLike>(card: T, ctx: NonNullable<CrewHourly>) {
  const isHourly = card.payType === "hourly";
  const time = ctx.perTask.get(card.id) ?? null;
  const rates = isHourly ? (ctx.taskRates.has(card.id) ? (ctx.taskRates.get(card.id) ?? null) : ctx.rates) : null;
  return {
    ...card,
    // Never a per-unit schedule, on any task, hourly or not.
    payBreakdown: null,
    labourCost: null,
    // An hourly task shows his ordinary rate per hour; a task agreed at a flat
    // amount before he went hourly keeps that agreed amount.
    payAmount: isHourly ? (rates?.standardRate ?? null) : card.payAmount,
    payNote: isHourly && !rates ? RATE_TO_CONFIRM : (card.payNote ?? null),
    payTotal: isHourly ? (time?.approvedPay ?? null) : (card.payAmount ?? null),
    ...("payTotalExGst" in card ? { payTotalExGst: isHourly ? (time?.approvedPay ?? null) : (card.payAmount ?? null) } : {}),
    gstRegistered: ctx.gstRegistered,
    hourly: isHourly
      ? {
          rates,
          rateToConfirm: !rates,
          approvedMinutes: time?.approvedMinutes ?? 0,
          approvedPay: time?.approvedPay ?? 0,
          recordedMinutes: time?.recordedMinutes ?? 0,
          open: time?.open ?? null,
        }
      : null,
  };
}

/** Task cards (today, upcoming, task). */
export async function redactCards<T extends CardLike>(installerId: number, cards: T[]) {
  const ctx = await crewHourlyContext(
    installerId,
    cards.filter((c) => c.payType === "hourly").map((c) => c.id),
  );
  if (ctx) return cards.map((c) => redactCard(c, ctx));
  // Damien, 11 Nov 2026: an hourly task given to someone with no hourly terms
  // yet reads "Rate to confirm", never $0 or the standard rate. His other
  // (fixed-price) cards are left exactly as they were.
  const hourlyIds = cards.filter((c) => c.payType === "hourly").map((c) => c.id);
  if (!hourlyIds.length) return cards;
  const forced = (await crewHourlyContext(installerId, hourlyIds, true))!;
  return cards.map((c) => (c.payType === "hourly" ? { ...redactCard(c, forced), payBreakdown: c.payBreakdown ?? null, labourCost: c.labourCost ?? null } : c));
}

/** Finished work list. payAmount is what he was paid on it: approved hours for hourly work. */
export async function redactHistory<T extends { id: number; payAmount: number | null; payBreakdown: unknown }>(
  installerId: number,
  rows: T[],
) {
  if (!(await isHourlyContractor(installerId))) return rows;
  const ids = rows.map((r) => r.id);
  const types = ids.length
    ? await db
        .select({ id: schema.jobTasks.id, payType: schema.jobTasks.payType })
        .from(schema.jobTasks)
        .where(inArray(schema.jobTasks.id, ids))
    : [];
  const hourlyIds = types.filter((t) => t.payType === "hourly").map((t) => t.id);
  const ctx = await crewHourlyContext(installerId, hourlyIds);
  return rows.map((r) => {
    const isHourly = hourlyIds.includes(r.id);
    const time = ctx?.perTask.get(r.id);
    return {
      ...r,
      payBreakdown: null,
      payAmount: isHourly ? (time?.approvedPay ?? 0) : r.payAmount,
      hourly: isHourly ? { approvedMinutes: time?.approvedMinutes ?? 0, approvedPay: time?.approvedPay ?? 0 } : null,
    };
  });
}

/** The Me tab: no rate on any skill, and earnings from his own approved pay. */
export async function redactMe<
  T extends {
    skills: Array<{ name: string; groupName: string | null; rateType: string; rate: number | null; canLead: boolean }>;
    stats: { completed: number; upcoming: number; earned: number };
  },
>(installerId: number, me: T) {
  if (!(await isHourlyContractor(installerId))) return me;
  const terms = await termsOn(installerId);
  const [flat] = await db
    .select({
      earned: sql<number>`sum(case when ${schema.jobTasks.status} = 'complete' and ${schema.jobTasks.payType} != 'hourly' then coalesce(${schema.jobTasks.payAmount}, 0) else 0 end)`,
    })
    .from(schema.jobTasks)
    .where(eq(schema.jobTasks.assignedInstallerId, installerId));
  const [hrs] = await db
    .select({
      pay: sql<number>`coalesce(sum(${schema.workSessions.approvedPay}), 0)`,
      minutes: sql<number>`coalesce(sum(${schema.workSessions.approvedMinutes}), 0)`,
    })
    .from(schema.workSessions)
    .where(and(eq(schema.workSessions.installerId, installerId), eq(schema.workSessions.status, "approved")));
  const approvedPay = round2(Number(hrs?.pay ?? 0));
  return {
    ...me,
    skills: me.skills.map((s) => ({ ...s, rateType: "hourly", rate: null })),
    stats: { ...me.stats, earned: round2(Number(flat?.earned ?? 0) + approvedPay) },
    hourly: {
      rates: terms && terms.baseRate > 0 ? ownRatesView(terms) : null,
      rateToConfirm: !(terms && terms.baseRate > 0),
      approvedPay,
      approvedMinutes: Number(hrs?.minutes ?? 0),
    },
  };
}

/** Offers: an hourly man is offered the work at his hourly rate, never a per-unit price. */
export async function redactOffers<T extends { taskId: number; payType: string; payAmount: number | null }>(
  installerId: number,
  rows: T[],
) {
  if (!(await isHourlyContractor(installerId))) {
    // No hourly terms on record: an hourly offer still never reads $0.
    return rows.map((r) => (r.payType === "hourly" ? { ...r, payAmount: null, payNote: RATE_TO_CONFIRM, hourly: { rates: null, rateToConfirm: true } } : r));
  }
  const terms = await termsOn(installerId);
  const pay = await taskPay(rows.map((r) => r.taskId));
  return rows.map((r) => {
    const rates = r.payType === "hourly" ? taskRatesView(terms, pay.get(r.taskId)) : null;
    return {
      ...r,
      payType: r.payType === "hourly" ? "hourly" : r.payType,
      payAmount: r.payType === "hourly" ? (rates?.standardRate ?? null) : r.payAmount,
      payNote: r.payType === "hourly" && !rates ? RATE_TO_CONFIRM : null,
      hourly: r.payType === "hourly" ? { rates, rateToConfirm: !rates } : null,
    };
  });
}

/** His rate card: his own three hourly rates, as rows every app build can show. */
export async function hourlyRateCard(installerId: number, on: string) {
  if (!(await isHourlyContractor(installerId))) return null;
  const terms = await termsOn(installerId, on);
  // $0 is never shown as a rate: no rows, and the card reads Rate to confirm.
  const r = terms && terms.baseRate > 0 ? ownRatesView(terms) : null;
  const rows = r
    ? [
        { itemId: -1, name: "Ordinary hours", groupName: "other", kind: "work", unit: "hour", amount: r.standardRate, minimumCharge: null, effectiveFrom: r.effectiveFrom },
        { itemId: -2, name: "Saturday and Sunday daytime", groupName: "other", kind: "work", unit: "hour", amount: r.weekendRate, minimumCharge: null, effectiveFrom: r.effectiveFrom },
        { itemId: -3, name: "Night / after hours (any day)", groupName: "other", kind: "work", unit: "hour", amount: r.nightRate, minimumCharge: null, effectiveFrom: r.effectiveFrom },
      ]
    : [];
  return {
    on,
    rates: rows,
    pendingChange: null,
    acknowledged: [] as Array<{ effectiveFrom: string; at: Date | null }>,
    hourly: r,
  };
}
