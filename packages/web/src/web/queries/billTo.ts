import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* Bill to (notes 18.54): who pays a job or quote, and the deposit % on their card. */

export type BillToValue = { type: "contact" | "company"; id: number };

export function useBillToOptions(input: { jobId?: number | null; quoteId?: number | null }, enabled = true) {
  return useQuery(orpc.billTo.options.queryOptions({ input, enabled, staleTime: 5_000 }));
}

export function useBillToSearch(q: string) {
  const term = q.trim();
  return useQuery(orpc.billTo.search.queryOptions({ input: { q: term }, enabled: term.length >= 2, staleTime: 10_000 }));
}

export function useBillToCards(list: BillToValue[]) {
  return useQuery(orpc.billTo.cards.queryOptions({ input: { list }, enabled: list.length > 0, staleTime: 5_000 }));
}

export function useCardsMissingDeposit() {
  return useQuery(orpc.billTo.missing.queryOptions({ staleTime: 10_000 }));
}

/** Save a % on a card. Draft quotes billed to it follow, so quotes, jobs and cards all refresh. */
export function useSetCardDeposit() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.billTo.setCardDeposit.mutationOptions({
      onSuccess: () => {
        for (const key of [orpc.billTo.key(), orpc.quotes.key(), orpc.jobs.key(), orpc.companies.key(), orpc.contacts.key()]) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      },
    }),
  );
}
