import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* Split by trade and Merge on the job page (fix list item 13). */

/** Each dispatch on a job with its work lines and whether it is free to change. */
export function useJobDispatchLines(jobId: number) {
  return useQuery(orpc.dispatches.forJob.queryOptions({ input: { jobId }, enabled: jobId > 0, staleTime: 5_000 }));
}

/** Everything that shows a dispatch or its work lines. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.dispatches.key() });
    queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
    queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    queryClient.invalidateQueries({ queryKey: orpc.costing.key() });
    queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() });
  };
}

export function useSplitDispatch() {
  const refresh = useRefresh();
  return useMutation(orpc.dispatches.split.mutationOptions({ onSuccess: refresh }));
}
export function useMergeDispatches() {
  const refresh = useRefresh();
  return useMutation(orpc.dispatches.merge.mutationOptions({ onSuccess: refresh }));
}
