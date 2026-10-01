import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Crew updates: who is on site now, red photo flags still open, and what the
 * crew has said by Siri or texted back in the last few days.
 */
export function useCrewUpdates(days = 3) {
  return useQuery(
    orpc.visits.feed.queryOptions({
      input: { days, limit: 60 },
      refetchInterval: 30_000,
      staleTime: 10_000,
    }),
  );
}

/** Every arrival and departure on one job. */
export function useJobVisits(jobId: number) {
  return useQuery(orpc.visits.forJob.queryOptions({ input: { jobId }, staleTime: 20_000 }));
}

/** Phones that can talk to Terra through Siri. */
export function useVoiceKeys() {
  return useQuery(orpc.voice.keys.queryOptions({ staleTime: 30_000 }));
}

export function useRevokeVoiceKey() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.voice.adminRevokeKey.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.voice.keys.key() }),
    }),
  );
}
