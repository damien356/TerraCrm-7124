import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Hourly contractor invoices, from the office side (Damien, 13 Nov 2026):
 * where each invoice stands (balance, Part paid), the time entries it bills,
 * and recording money paid. Recording a payment needs costs access; the
 * server checks it.
 */

export function useInvoiceBalances(invoiceIds: number[]) {
  return useQuery(
    orpc.hourlyInvoices.balances.queryOptions({ input: { invoiceIds }, enabled: invoiceIds.length > 0, staleTime: 10_000, retry: false }),
  );
}

export function useInvoiceEntries(invoiceId: number | null) {
  return useQuery(orpc.hourlyInvoices.invoiceEntries.queryOptions({ input: { invoiceId: invoiceId ?? 0 }, enabled: invoiceId != null, retry: false }));
}

export function useRecordPayment() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.hourlyInvoices.recordPayment.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.hourlyInvoices.key() });
        queryClient.invalidateQueries({ queryKey: orpc.installerInvoices.key() });
      },
    }),
  );
}

/** Damien, 13 Nov 2026: read Xero bills and flag invoices that look paid. Read only, nothing recorded. */
export function useXeroPaymentCheck() {
  return useMutation(orpc.hourlyInvoices.xeroCheck.mutationOptions());
}
