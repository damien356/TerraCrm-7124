import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* Who gets what on a job (Damien, 14 Nov 2026): quotes, variations and invoices per person and the company. */

export function usePaperwork(jobId: number | null | undefined) {
  return useQuery(orpc.paperwork.get.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: !!jobId, staleTime: 5_000 }));
}

/** A tick changes who the quote, variation, invoice and follow-up screens offer. */
export function useSetPaperwork() {
  const qc = useQueryClient();
  return useMutation(
    orpc.paperwork.set.mutationOptions({
      onSuccess: () => {
        for (const key of [orpc.paperwork.key(), orpc.quoteSend.key(), orpc.variations.key(), orpc.clientInvoices.key(), orpc.quoteFollowups.key(), orpc.customerComms.key()]) {
          qc.invalidateQueries({ queryKey: key });
        }
      },
    }),
  );
}
