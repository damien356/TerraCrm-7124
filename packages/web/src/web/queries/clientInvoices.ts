import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** IQ invoices on a job, with billed, received and owing. */
export function useClientInvoices(jobId: number) {
  return useQuery(orpc.clientInvoices.forJob.queryOptions({ input: { jobId }, staleTime: 10_000 }));
}

export function useMaterialSelection(jobId: number) {
  return useQuery(orpc.clientInvoices.selection.queryOptions({ input: { jobId }, staleTime: 15_000 }));
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.clientInvoices.key() });
    queryClient.invalidateQueries({ queryKey: orpc.finance.key() });
    queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    queryClient.invalidateQueries({ queryKey: orpc.quoteSend.key() });
  };
}

export function useMarkInvoicePaid() {
  const onSuccess = useRefresh();
  return useMutation(orpc.clientInvoices.markPaid.mutationOptions({ onSuccess }));
}

export function useVoidInvoice() {
  const onSuccess = useRefresh();
  return useMutation(orpc.clientInvoices.void.mutationOptions({ onSuccess }));
}

export function useSendSelection() {
  const onSuccess = useRefresh();
  return useMutation(orpc.clientInvoices.sendSelection.mutationOptions({ onSuccess }));
}

/** Email the invoice with its Pay by card link and the bank details. */
export function useEmailInvoice() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.clientInvoices.email.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.conversations.key() }),
    }),
  );
}
