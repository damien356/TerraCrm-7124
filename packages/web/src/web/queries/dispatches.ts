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
    queryClient.invalidateQueries({ queryKey: orpc.installerBoard.key() });
  };
}

export function useSplitDispatch() {
  const refresh = useRefresh();
  return useMutation(orpc.dispatches.split.mutationOptions({ onSuccess: refresh }));
}
/** Rename a dispatch on the job page. Only the name changes. */
export function useRenameDispatch() {
  const refresh = useRefresh();
  return useMutation(orpc.dispatches.rename.mutationOptions({ onSuccess: refresh }));
}
export function useMergeDispatches() {
  const refresh = useRefresh();
  return useMutation(orpc.dispatches.merge.mutationOptions({ onSuccess: refresh }));
}

/* Allocate labour on a job (Damien's brief, 7 Nov 2026). */

/** Each dispatch on a job with its status, lines, who has it, and what is not pay. */
export function useJobAllocation(jobId: number) {
  return useQuery(orpc.dispatches.allocation.queryOptions({ input: { jobId }, enabled: jobId > 0, staleTime: 5_000 }));
}
/** What an allocation would do: scope, recipient, clashes and anything stopping it. Writes nothing. */
export function usePreviewAllocate() {
  return useMutation(orpc.dispatches.previewAllocate.mutationOptions());
}
/** Book the ticked lines to one person as one visit. Sends no offer and no message. */
export function useAllocate() {
  const refresh = useRefresh();
  return useMutation(orpc.dispatches.allocate.mutationOptions({ onSuccess: refresh }));
}
