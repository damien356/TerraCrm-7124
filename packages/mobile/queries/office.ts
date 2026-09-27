import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/api";

/**
 * Admin-only data. Every hook here sits behind `adminOnly` on the server, so an
 * installer login gets FORBIDDEN even if it somehow reached this screen.
 */
export function useOfficeSummary(enabled: boolean) {
  return useQuery(
    orpc.dashboard.summary.queryOptions({ enabled, refetchInterval: 60_000, retry: false }),
  );
}

export function useLiveCrew(enabled: boolean) {
  return useQuery(
    orpc.crew.live.queryOptions({
      input: { staleMinutes: 45 },
      enabled,
      refetchInterval: 60_000,
      retry: false,
    }),
  );
}
