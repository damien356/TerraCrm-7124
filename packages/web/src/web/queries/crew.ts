import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Live crew positions. On-shift only — the API refuses to record anything
 * outside a running task, so an empty map means nobody is on the clock.
 */
export function useLiveCrew(staleMinutes = 45) {
  return useQuery(
    orpc.crew.live.queryOptions({
      input: { staleMinutes },
      refetchInterval: 30_000,
      staleTime: 10_000,
    }),
  );
}

/** Who's running a job right now, sharing or not. */
export function useOnShift() {
  return useQuery(orpc.crew.onShift.queryOptions({ refetchInterval: 30_000 }));
}

/** Which installers have location sharing switched on. Read-only in the office. */
export function useCrewSharing() {
  return useQuery(orpc.crew.sharingStatus.queryOptions({ staleTime: 60_000 }));
}

/** Today's breadcrumb trail for one installer. */
export function useCrewTrail(installerId: number | null, hours = 12) {
  return useQuery(
    orpc.crew.trail.queryOptions({
      input: { installerId: installerId ?? 0, hours },
      enabled: installerId !== null,
      staleTime: 20_000,
    }),
  );
}

export function useClearTrail() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.crew.clearTrail.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.crew.key() }),
    }),
  );
}
