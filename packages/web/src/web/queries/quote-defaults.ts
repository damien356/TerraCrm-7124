import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Quote defaults warnings still stopping the quote going out (7 Nov). */
export function useOpenDefaultWarnings(quoteId: number | null) {
  return useQuery(
    orpc.quoteDefaults.open.queryOptions({ input: { quoteId: quoteId ?? 0 }, enabled: quoteId != null, staleTime: 0 }),
  );
}

/** The Install trims/scotia lines on the quote, for a trim's Install with pick. */
export function useTrimChoices(quoteId: number | null, enabled = true) {
  return useQuery(
    orpc.quoteDefaults.trimChoices.queryOptions({ input: { quoteId: quoteId ?? 0 }, enabled: enabled && quoteId != null, staleTime: 0 }),
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.quotes.key() });
    queryClient.invalidateQueries({ queryKey: orpc.quoteDefaults.key() });
  };
}

export function useReviewDefault() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteDefaults.review.mutationOptions({ onSuccess: refresh }));
}

export function useCoverTrim() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteDefaults.coverTrim.mutationOptions({ onSuccess: refresh }));
}

/** Area prep lines and the floor area each follows (10 Nov). */
export function usePrepLinks(quoteId: number | null, enabled = true) {
  return useQuery(
    orpc.quoteDefaults.prepLinks.queryOptions({ input: { quoteId: quoteId ?? 0 }, enabled: enabled && quoteId != null, staleTime: 0 }),
  );
}

export function useFollowArea() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteDefaults.followArea.mutationOptions({ onSuccess: refresh }));
}

export function useConfirmPartial() {
  const refresh = useRefresh();
  return useMutation(orpc.quoteDefaults.confirmPartial.mutationOptions({ onSuccess: refresh }));
}
