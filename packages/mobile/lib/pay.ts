import type { FieldTask } from "@/components/task-card";

/**
 * Fixed-price pay across a list of job cards, each job counted once. A 6 day
 * lay shows as 6 cards, one per day, but it is one job paid once (notes 18.61).
 */
export function fixedPay(tasks: FieldTask[]) {
  const seen = new Set<number>();
  let sum = 0;
  for (const t of tasks) {
    if (seen.has(t.id) || t.payType !== "per_job") continue;
    seen.add(t.id);
    sum += t.payTotal ?? t.payAmount ?? 0;
  }
  return sum;
}

/**
 * The Today pay tile. Damien, 11 Nov 2026: an hourly day never reads
 * "$0 fixed-price work". Hourly work shows as hourly; both together say so.
 */
export function payTile(tasks: FieldTask[]): { amount: number | null; label: string } {
  const fixed = fixedPay(tasks);
  const hourlyJobs = new Set(tasks.filter((t) => t.payType === "hourly").map((t) => t.id)).size;
  const fixedJobs = new Set(tasks.filter((t) => t.payType === "per_job").map((t) => t.id)).size;
  if (!hourlyJobs) return { amount: fixed, label: "fixed-price work" };
  const hourlyWord = hourlyJobs === 1 ? "1 hourly job" : `${hourlyJobs} hourly jobs`;
  if (!fixedJobs) return { amount: null, label: hourlyWord };
  return { amount: fixed, label: `fixed-price, plus ${hourlyWord}` };
}
