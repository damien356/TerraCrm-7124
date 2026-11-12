import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { BUDGET_THRESHOLDS, jobHourlyCosting } from "./hourly";
import { notifyOffice } from "./notify";
import { jobText } from "./refs";

/**
 * Damien, 11 Nov 2026: tell the office when a job's hourly labour reaches 80%
 * and 100% of its estimated hourly-labour budget. The whole job counts: every
 * hourly worker and helper, approved time and logged time not yet approved.
 *
 * Each threshold alerts once per job. The claim is a settings row
 * (hourly_budget_alert:<jobId>:<80|100>) written with ON CONFLICT DO NOTHING,
 * so two taps at once still make one alert. It never stops a timer, removes
 * hours or changes the customer's price, and it never throws into the caller.
 */
export const budgetAlertKey = (jobId: number, threshold: number) => `hourly_budget_alert:${jobId}:${threshold}`;

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hours = (m: number) => `${Math.round((m / 60) * 100) / 100} h`;

export async function checkJobBudget(jobId: number | null | undefined): Promise<number[]> {
  const sent: number[] = [];
  if (!jobId) return sent;
  try {
    const c = await jobHourlyCosting(jobId);
    const b = c.budget;
    if (b.amount == null || !b.reached.length) return sent;
    const [job] = await db.select({ number: schema.jobs.number, displayNumber: schema.jobs.displayNumber }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
    const ref = job ? jobText(job) : String(jobId);
    // Claim every threshold reached. If one check passes both at once, the office gets one message, not two.
    for (const th of BUDGET_THRESHOLDS) {
      if (!b.reached.includes(th)) continue;
      const [claimed] = await db
        .insert(schema.settings)
        .values({ key: budgetAlertKey(jobId, th), value: JSON.stringify({ at: new Date().toISOString(), pct: b.pct, forecast: b.forecast, amount: b.amount }) })
        .onConflictDoNothing()
        .returning({ key: schema.settings.key });
      if (claimed) sent.push(th);
    }
    if (!sent.length) return sent;
    const th = Math.max(...sent);
    const lines = [
      `Hourly labour on job ${ref} is at ${b.pct}% of its estimated hourly-labour budget of ${money(b.amount)}.`,
      `Approved cost: ${money(b.approved)} (${hours(b.approvedMinutes)}).`,
      `Logged, not yet approved (estimate): ${money(b.unapproved)} (${hours(b.unapprovedMinutes)}).`,
      `Forecast so far: ${money(b.forecast)}.`,
    ];
    if (b.uncostedMinutes > 0) lines.push(`Also ${hours(b.uncostedMinutes)} logged with the rate or pay setting still to confirm. Not in the dollar figures.`);
    if (b.tasksWithoutPlan > 0) lines.push(`${b.tasksWithoutPlan} hourly task(s) on this job have no planned hours, so they are not in the budget.`);
    lines.push("Nothing was stopped or changed. The timer keeps running and the customer's price is unchanged.");
    await notifyOffice("hourly_budget", {
      title: `Job ${ref}: hourly labour at ${th}% of budget`,
      body: lines.join("\n"),
      // Pushes go to every office phone, including logins that cannot see costs: no dollar figures there.
      pushBody: `Hourly time on job ${ref} has reached ${th}% of its hourly-labour budget. Nothing was stopped and the price is unchanged.`,
      jobId,
      path: `/jobs/${jobId}`,
    });
  } catch (e) {
    console.error("[hourly-budget] check failed", jobId, e);
  }
  return sent;
}
