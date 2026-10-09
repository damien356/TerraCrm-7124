import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* The no-login client pages. Each call carries only the link token. */

export function usePublicQuote(token: string) {
  // One fetch per visit: a refetch on focus would count another view.
  return useQuery(
    orpc.publicPages.quote.get.queryOptions({
      input: { token },
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    }),
  );
}

export const usePublicQuotePdf = () => useMutation(orpc.publicPages.quote.pdf.mutationOptions());

export function useAcceptQuoteOnline() {
  return useMutation(orpc.publicPages.quote.accept.mutationOptions());
}

export function usePublicSelection(token: string) {
  return useQuery(
    orpc.publicPages.selection.get.queryOptions({ input: { token }, refetchOnWindowFocus: false, retry: false }),
  );
}

export function useSubmitSelection() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.publicPages.selection.submit.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.publicPages.selection.key() }),
    }),
  );
}
