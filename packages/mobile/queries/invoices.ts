import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "@/lib/api";

/**
 * The installer's own subcontractor invoice to Terra for a completed task.
 * Everything here hits `orpc.installerInvoices.*`, scoped to the signed-in
 * installer on the server. No pricing beyond the installer's own agreed pay
 * ever comes back through these.
 */

export function useInvoicePreview(taskId: number) {
  return useQuery(
    orpc.installerInvoices.preview.queryOptions({ input: { taskId }, enabled: Number.isFinite(taskId) }),
  );
}

export function useMyVariations(taskId: number) {
  return useQuery(
    orpc.installerInvoices.myVariations.queryOptions({ input: { taskId }, enabled: Number.isFinite(taskId) }),
  );
}

export function useMyInvoices() {
  return useQuery(orpc.installerInvoices.myInvoices.queryOptions());
}

function useInvalidateInvoices() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.installerInvoices.key() });
}

export function useRequestVariation() {
  const invalidate = useInvalidateInvoices();
  return useMutation(orpc.installerInvoices.requestVariation.mutationOptions({ onSuccess: invalidate }));
}

export function useSubmitInvoice() {
  const invalidate = useInvalidateInvoices();
  return useMutation(orpc.installerInvoices.submit.mutationOptions({ onSuccess: invalidate }));
}

export function useInvoiceDownloadUrl() {
  return useMutation(orpc.installerInvoices.downloadUrl.mutationOptions());
}
