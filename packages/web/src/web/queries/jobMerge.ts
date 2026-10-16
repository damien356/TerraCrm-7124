import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** What merging one job into another would move, and why it is blocked, before anything runs. */
export function useMergePreview(fromJobId: number | null, intoJobId: number | null) {
  return useQuery(
    orpc.jobMerge.preview.queryOptions({
      input: { fromJobId: fromJobId ?? 0, intoJobId: intoJobId ?? 0 },
      enabled: !!fromJobId && !!intoJobId,
      staleTime: 0,
    }),
  );
}

/** Merge a job into another. It touches people, mail, dispatches, quotes and the forecast, so every query refreshes. */
export function useMergeJobs() {
  const queryClient = useQueryClient();
  return useMutation(orpc.jobMerge.run.mutationOptions({ onSuccess: () => queryClient.invalidateQueries() }));
}
