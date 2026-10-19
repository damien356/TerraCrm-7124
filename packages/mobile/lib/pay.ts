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
