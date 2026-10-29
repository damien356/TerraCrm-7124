import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** IQ invoices on a job, with billed, received and owing. */
export function useClientInvoices(jobId: number) {
  return useQuery(orpc.clientInvoices.forJob.queryOptions({ input: { jobId }, staleTime: 10_000 }));
}

export function useMaterialSelection(jobId: number) {
  return useQuery(orpc.clientInvoices.selection.queryOptions({ input: { jobId }, staleTime: 15_000 }));
}

/** What is left to bill on the job, the default due date and who it goes to. */
export function useJobBilling(jobId: number) {
  return useQuery(orpc.clientInvoices.billing.queryOptions({ input: { jobId }, staleTime: 10_000 }));
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.clientInvoices.key() });
    queryClient.invalidateQueries({ queryKey: orpc.delivery.key() });
    queryClient.invalidateQueries({ queryKey: orpc.finance.key() });
    queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    queryClient.invalidateQueries({ queryKey: orpc.quoteSend.key() });
  };
}

export function useMarkInvoicePaid() {
  const onSuccess = useRefresh();
  return useMutation(orpc.clientInvoices.markPaid.mutationOptions({ onSuccess }));
}

/** Task H: Customer sales (200) or Installer materials (204). Only before the invoice is in Xero. */
export function useSetSalesCategory() {
  const onSuccess = useRefresh();
  return useMutation(orpc.clientInvoices.setSalesCategory.mutationOptions({ onSuccess }));
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

/** Raise a final or progress invoice, emailed now if asked. */
export function useRaiseInvoice() {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation(
    orpc.clientInvoices.raise.mutationOptions({
      onSuccess: () => {
        refresh();
        queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
      },
    }),
  );
}
