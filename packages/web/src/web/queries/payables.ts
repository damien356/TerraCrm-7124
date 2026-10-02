import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Suppliers owed: invoices the email agent read, matched to POs raised in Ops. */

export function useOwed() {
  return useQuery(orpc.payables.owed.queryOptions({ staleTime: 15_000 }));
}

export function useSupplierOwed(key: string | null) {
  return useQuery(orpc.payables.supplier.queryOptions({ input: { key: key ?? "" }, enabled: !!key, staleTime: 10_000 }));
}

export function useSupplierInvoice(id: number | null) {
  return useQuery(orpc.payables.invoice.queryOptions({ input: { id: id ?? 0 }, enabled: id != null, staleTime: 10_000 }));
}

export function useInvoiceRequest(id: number | null) {
  return useQuery(orpc.payables.request.queryOptions({ input: { id: id ?? 0 }, enabled: id != null, staleTime: 0 }));
}

function usePayablesRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.payables.key() });
    queryClient.invalidateQueries({ queryKey: orpc.purchasing.key() });
    queryClient.invalidateQueries({ queryKey: orpc.finance.key() });
    queryClient.invalidateQueries({ queryKey: orpc.mail.key() });
    queryClient.invalidateQueries({ queryKey: orpc.suppliers.key() });
  };
}

// Written out one by one so each hook keeps its own input and output types.
export const useMatchInvoice = () => useMutation(orpc.payables.match.mutationOptions({ onSuccess: usePayablesRefresh() }));
export const useRematchInvoice = () => useMutation(orpc.payables.rematch.mutationOptions({ onSuccess: usePayablesRefresh() }));
export const useSetInvoiceSupplier = () => useMutation(orpc.payables.setSupplier.mutationOptions({ onSuccess: usePayablesRefresh() }));
export const useMarkInvoicePaid = () => useMutation(orpc.payables.markPaid.mutationOptions({ onSuccess: usePayablesRefresh() }));
export const useMarkInvoiceChecked = () => useMutation(orpc.payables.markChecked.mutationOptions({ onSuccess: usePayablesRefresh() }));
export const useEditRequest = () => useMutation(orpc.payables.requestEdit.mutationOptions({ onSuccess: usePayablesRefresh() }));
export const useSendRequest = () => useMutation(orpc.payables.requestSend.mutationOptions({ onSuccess: usePayablesRefresh() }));
export const useCancelRequest = () => useMutation(orpc.payables.requestCancel.mutationOptions({ onSuccess: usePayablesRefresh() }));
export const useSetAutoSend = () => useMutation(orpc.payables.setAutoSend.mutationOptions({ onSuccess: usePayablesRefresh() }));
export const useUploadSupplierPdf = () => useMutation(orpc.payables.uploadPdf.mutationOptions({ onSuccess: usePayablesRefresh() }));
