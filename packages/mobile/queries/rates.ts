import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/api";

/**
 * The installer's own rate card, everything he's ticked for. Backed by
 * `labour.myRates`, which is installer-scoped on the server: his own rates
 * only, never Terra's default and never anyone else's.
 */
export function useMyRates() {
  return useQuery(orpc.labour.myRates.queryOptions({ staleTime: 60_000 }));
}
