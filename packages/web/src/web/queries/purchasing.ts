import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

/**
 * Purchase orders raised from a job (4113-A, 4113-B). Sending one commits the
 * cost on the job and feeds the cashflow forecast, so every change refreshes
 * the job, the finance screens and Suppliers owed as well.
 */

export function usePurchasingForJob(jobId: number | null) {
  return useQuery(orpc.purchasing.forJob.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: jobId != null, staleTime: 5_000 }));
}

export function useFeeRules(supplierId: number | null) {
  return useQuery(
    orpc.purchasing.feeRules.queryOptions({ input: { supplierId: supplierId ?? 0 }, enabled: supplierId != null, staleTime: 60_000 }),
  );
}

export type PoPreviewInput = Parameters<typeof client.purchasing.preview>[0];

/** Live price of the PO being written. Nothing is saved. */
export function usePoPreview(input: PoPreviewInput | null) {
  return useQuery(
    orpc.purchasing.preview.queryOptions({
      input: input ?? ({ jobId: 0, supplierId: 0, lines: [{ kind: "goods", qty: 0 }] } as PoPreviewInput),
      enabled: input != null,
      staleTime: 0,
      retry: false,
      placeholderData: (prev) => prev,
    }),
  );
}

export function useOpenPosForSupplier(supplierId: number | null) {
  return useQuery(
    orpc.purchasing.openForSupplier.queryOptions({ input: { supplierId: supplierId ?? 0 }, enabled: supplierId != null, staleTime: 10_000 }),
  );
}

function usePoRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.purchasing.key() });
    queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    queryClient.invalidateQueries({ queryKey: orpc.finance.key() });
    queryClient.invalidateQueries({ queryKey: orpc.payables.key() });
    queryClient.invalidateQueries({ queryKey: orpc.suppliers.key() });
  };
}

// Written out one by one so each hook keeps its own input and output types.
export const useCreatePo = () => useMutation(orpc.purchasing.create.mutationOptions({ onSuccess: usePoRefresh() }));
export const useUpdatePo = () => useMutation(orpc.purchasing.update.mutationOptions({ onSuccess: usePoRefresh() }));
export const useRemovePoDraft = () => useMutation(orpc.purchasing.removeDraft.mutationOptions({ onSuccess: usePoRefresh() }));
export const useSendPo = () => useMutation(orpc.purchasing.send.mutationOptions({ onSuccess: usePoRefresh() }));
export const useMarkPoSent = () => useMutation(orpc.purchasing.markSent.mutationOptions({ onSuccess: usePoRefresh() }));
export const useCancelPo = () => useMutation(orpc.purchasing.cancel.mutationOptions({ onSuccess: usePoRefresh() }));

/** The PDF as base64, for a look before it goes. */
export const usePoPdf = () => useMutation(orpc.purchasing.pdf.mutationOptions());
export const useStoredPoPdfUrl = () => useMutation(orpc.purchasing.storedPdfUrl.mutationOptions());
