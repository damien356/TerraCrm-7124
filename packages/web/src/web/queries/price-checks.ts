import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Price checks: invoice rates that differ from the Ops price list. Nothing changes until Damien approves. */

export function usePriceChecks() {
  return useQuery(orpc.priceChecks.list.queryOptions({ staleTime: 15_000 }));
}

export function useInvoicePriceChecks(invoiceId: number | null) {
  return useQuery(orpc.priceChecks.forInvoice.queryOptions({ input: { invoiceId: invoiceId ?? 0 }, enabled: invoiceId != null, staleTime: 10_000 }));
}

function usePriceRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.priceChecks.key() });
    queryClient.invalidateQueries({ queryKey: orpc.payables.key() });
    queryClient.invalidateQueries({ queryKey: orpc.suppliers.key() });
    queryClient.invalidateQueries({ queryKey: orpc.products.key() });
    queryClient.invalidateQueries({ queryKey: orpc.purchasing.key() });
  };
}

export const useApproveFlag = () => useMutation(orpc.priceChecks.approve.mutationOptions({ onSuccess: usePriceRefresh() }));
export const useIgnoreFlag = () => useMutation(orpc.priceChecks.ignore.mutationOptions({ onSuccess: usePriceRefresh() }));
export const useRecheckInvoice = () => useMutation(orpc.priceChecks.recheck.mutationOptions({ onSuccess: usePriceRefresh() }));
