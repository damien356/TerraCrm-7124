import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** What the Email quote dialog opens with. Only fetched while the dialog is open. */
export function useQuoteEmailDraft(quoteId: number, open: boolean) {
  return useQuery(orpc.quoteSend.draft.queryOptions({ input: { quoteId }, enabled: open, staleTime: 0 }));
}

/** The client link on a quote: url, views, the signature and the deposit invoice. */
export function useQuoteLink(quoteId: number) {
  return useQuery(orpc.quoteSend.link.queryOptions({ input: { quoteId }, staleTime: 15_000 }));
}

export function useSendQuoteEmail() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.quoteSend.send.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.quotes.key() });
        queryClient.invalidateQueries({ queryKey: orpc.quoteSend.key() });
        queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
        queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
      },
    }),
  );
}
