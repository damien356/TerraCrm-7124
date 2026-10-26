/**
 * The booking safety switch and the server side clash rule (measure booking
 * stage 0).
 *
 * Off by default. With the `booking_safety` setting at "1":
 * - a booking writes its days, its history and the task in one batch,
 * - a repeat of the same request key gets the first answer back,
 * - a save made from an old version of the task is refused,
 * - booking over a clash or a day off needs a reason.
 * Off, booking behaves exactly as it did before stage 0.
 */
import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { checkDays } from "./availability";

export const BOOKING_SAFETY_KEY = "booking_safety";

export async function bookingSafetyOn(): Promise<boolean> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, BOOKING_SAFETY_KEY));
  return row?.value?.trim() === "1";
}

export interface DayProblem {
  date: string;
  installerId: number;
  what: string;
}

/**
 * Every day in the run that clashes with other work or falls on a day off,
 * checked against whoever is on that day. Same filter as the Book Installer
 * panel: this task's own days and other dispatches on the same job are never
 * a clash.
 */
export async function dayProblems(args: {
  taskId: number;
  jobId: number;
  installerId: number;
  dates: string[];
  /** Days handed to a different installer. */
  perDayInstaller?: Map<string, number | null | undefined>;
}): Promise<DayProblem[]> {
  const byInstaller = new Map<number, string[]>();
  for (const date of args.dates) {
    const who = args.perDayInstaller?.get(date) || args.installerId;
    byInstaller.set(who, [...(byInstaller.get(who) ?? []), date]);
  }
  const out: DayProblem[] = [];
  for (const [installerId, dates] of byInstaller) {
    const checks = await checkDays({ installerId, dates, exceptTaskId: args.taskId });
    for (const c of checks) {
      const clashes = c.clashes.filter((x) => x.taskId !== args.taskId && x.jobId !== args.jobId);
      if (clashes.length) out.push({ date: c.date, installerId, what: `already booked on Job #${clashes[0]!.jobNumber}` });
      else if (c.status !== "available") out.push({ date: c.date, installerId, what: c.reason ?? "Not available" });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function needsReasonMessage(
  problems: DayProblem[],
  say: (date: string) => string,
  how = "Add a reason to book over it.",
): string {
  const first = problems[0]!;
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more day${problems.length > 2 ? "s" : ""})` : "";
  return `${say(first.date)}: ${first.what}${more}. ${how}`;
}
