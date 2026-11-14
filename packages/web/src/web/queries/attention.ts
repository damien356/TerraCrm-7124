import { useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** The "Needs attention" lists the home-screen widget opens (Damien, 14 Nov 2026). */
export function useAttention() {
  return useQuery(orpc.widget.attention.queryOptions({ input: {}, staleTime: 20_000, refetchInterval: 60_000 }));
}
