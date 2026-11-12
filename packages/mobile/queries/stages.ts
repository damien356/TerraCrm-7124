import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/api";

/**
 * Staged jobs (Damien, 12 Nov 2026). His stages on a task: what is finished,
 * what he can claim, what is left and when he goes back. Pay only, never a
 * selling price. Null when the task is not staged.
 */
export function useCrewStages(taskId: number) {
  return useQuery(orpc.stages.crew.queryOptions({ input: { taskId }, enabled: Number.isFinite(taskId), staleTime: 30_000 }));
}
