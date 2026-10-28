import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* Quote follow-up emails (28 Oct): the card on the quote and the job, the backlog and Settings. */

export function useQuoteFollowups(quoteId: number) {
  return useQuery(orpc.quoteFollowups.view.queryOptions({ input: { quoteId }, staleTime: 5_000 }));
}

export function useJobFollowups(jobId: number) {
  return useQuery(orpc.quoteFollowups.forJob.queryOptions({ input: { jobId }, staleTime: 5_000 }));
}

export function useFollowupBacklog() {
  return useQuery(orpc.quoteFollowups.backlog.queryOptions({ staleTime: 30_000 }));
}

export function useFollowupMetrics() {
  return useQuery(orpc.quoteFollowups.metrics.queryOptions({ staleTime: 30_000 }));
}

export function useFollowupSettings() {
  return useQuery(orpc.quoteFollowups.settings.queryOptions({ staleTime: 10_000 }));
}

/** Everything that changes what the card shows: the follow-ups, the quote and its history, the thread. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [orpc.quoteFollowups.key(), orpc.quotes.key(), orpc.conversations.key(), orpc.officeTasks.key()]) queryClient.invalidateQueries({ queryKey: key });
  };
}

export function useFollowupEnrol() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteFollowups.enrol.mutationOptions({ onSuccess: refresh }));
}

export function useFollowupPause() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteFollowups.pause.mutationOptions({ onSuccess: refresh }));
}

export function useFollowupResume() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteFollowups.resume.mutationOptions({ onSuccess: refresh }));
}

export function useFollowupStop() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteFollowups.stop.mutationOptions({ onSuccess: refresh }));
}

export function useFollowupSkip() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteFollowups.skip.mutationOptions({ onSuccess: refresh }));
}

export function useFollowupEdit() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteFollowups.edit.mutationOptions({ onSuccess: refresh }));
}

export function useFollowupSetDate() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteFollowups.setDate.mutationOptions({ onSuccess: refresh }));
}

export function useSaveFollowupSettings() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteFollowups.saveSettings.mutationOptions({ onSuccess: refresh }));
}
