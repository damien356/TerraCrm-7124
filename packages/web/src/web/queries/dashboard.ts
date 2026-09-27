import { useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useDashboard() {
  return useQuery(orpc.dashboard.summary.queryOptions({ staleTime: 20_000, refetchInterval: 60_000 }));
}
