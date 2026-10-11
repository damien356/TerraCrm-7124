import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* Variations on a job (item 12). Staff only. The client page is in queries/publicPages.ts. */

export function useJobVariations(jobId: number) {
  return useQuery(orpc.variations.list.queryOptions({ input: { jobId }, staleTime: 5_000 }));
}

export function useVariationDraft(id: number | null) {
  return useQuery(
    orpc.variations.draft.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 0, refetchOnWindowFocus: false }),
  );
}

/** A variation change can move the job value, its invoices, dispatches and materials. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.variations.key() });
    queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
  };
}

function useRefreshAll() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.variations.key() });
    queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
    queryClient.invalidateQueries({ queryKey: orpc.clientInvoices.key() });
    queryClient.invalidateQueries({ queryKey: orpc.finance.key() });
    queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
  };
}

export const useCreateVariation = () => useMutation(orpc.variations.create.mutationOptions({ onSuccess: useRefresh() }));
export const useUpdateVariation = () => useMutation(orpc.variations.update.mutationOptions({ onSuccess: useRefresh() }));
export const useDeleteVariation = () => useMutation(orpc.variations.delete.mutationOptions({ onSuccess: useRefresh() }));
export const useAddVariationProduct = () => useMutation(orpc.variations.addProduct.mutationOptions({ onSuccess: useRefresh() }));
export const useAddVariationLabour = () => useMutation(orpc.variations.addLabour.mutationOptions({ onSuccess: useRefresh() }));
export const useAddVariationOther = () => useMutation(orpc.variations.addOther.mutationOptions({ onSuccess: useRefresh() }));
export const useUpdateVariationLine = () => useMutation(orpc.variations.updateLine.mutationOptions({ onSuccess: useRefresh() }));
export const useRemoveVariationLine = () => useMutation(orpc.variations.removeLine.mutationOptions({ onSuccess: useRefresh() }));
export const useSendVariation = () => useMutation(orpc.variations.send.mutationOptions({ onSuccess: useRefreshAll() }));
export const useAcceptVariation = () => useMutation(orpc.variations.accept.mutationOptions({ onSuccess: useRefreshAll() }));
export const useRejectVariation = () => useMutation(orpc.variations.reject.mutationOptions({ onSuccess: useRefreshAll() }));
export const useVariationPdf = () => useMutation(orpc.variations.pdf.mutationOptions());
