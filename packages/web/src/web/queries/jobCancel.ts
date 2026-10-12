import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** What Real cancel and Clear everything would each do to the job, before anything runs. */
export function useCancelPreview(jobId: number | null) {
  return useQuery(orpc.jobCancel.preview.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: !!jobId, staleTime: 0 }));
}

/** Cancel the job. It touches quotes, invoices, POs, dispatches, tasks and the forecast, so every query refreshes. */
export function useCancelJob() {
  const queryClient = useQueryClient();
  return useMutation(orpc.jobCancel.run.mutationOptions({ onSuccess: () => queryClient.invalidateQueries() }));
}
