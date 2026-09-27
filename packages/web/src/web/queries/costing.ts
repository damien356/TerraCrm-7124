import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Job costing. The measured work sits on the task, the money is worked out per
 * installer off the rate book, and a missing rate comes back as missing rather
 * than as zero. Admin only, same as the procedures behind it.
 */

/** The measured lines on one task, priced against whoever is on it. */
export function useTaskLines(taskId: number | null, input: { installerId?: number | null; on?: string } = {}) {
  return useQuery(
    orpc.costing.taskLines.queryOptions({
      input: { taskId: taskId ?? 0, installerId: input.installerId ?? null, on: input.on },
      enabled: taskId != null,
      staleTime: 5_000,
    }),
  );
}

/** Revenue, materials, labour, GP and margin for a job, plus every installer's price on it. */
export function useForecast(jobId: number | null, input: { installerId?: number | null; on?: string } = {}) {
  return useQuery(
    orpc.costing.forecast.queryOptions({
      input: { jobId: jobId ?? 0, installerId: input.installerId ?? null, on: input.on },
      enabled: jobId != null,
      staleTime: 5_000,
    }),
  );
}

function useCostingMutation(name: "setLine" | "removeLine" | "freeze" | "unfreeze") {
  const queryClient = useQueryClient();
  return orpc.costing[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.costing.key() });
      // Freezing writes the labour onto the task, so the job card is stale too.
      queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    },
  });
}

export function useSetLine() {
  return useMutation(useCostingMutation("setLine"));
}

export function useRemoveLine() {
  return useMutation(useCostingMutation("removeLine"));
}

export function useFreezeLabour() {
  return useMutation(useCostingMutation("freeze"));
}

export function useUnfreezeLabour() {
  return useMutation(useCostingMutation("unfreeze"));
}
