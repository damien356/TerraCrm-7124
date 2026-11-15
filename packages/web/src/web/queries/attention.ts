import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** The "Needs attention" lists the home-screen widget opens (Damien, 14 Nov 2026). */
export function useAttention() {
  return useQuery(orpc.widget.attention.queryOptions({ input: {}, staleTime: 20_000, refetchInterval: 60_000 }));
}

/** Measures awaiting a quote: record that no quote is needed, or undo it. Sends nothing. */
export function useQuoteNeeded() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: orpc.widget.key() });
  return {
    notNeeded: useMutation(orpc.widget.quoteNotNeeded.mutationOptions({ onSuccess: refresh })),
    neededAgain: useMutation(orpc.widget.quoteNeededAgain.mutationOptions({ onSuccess: refresh })),
  };
}
