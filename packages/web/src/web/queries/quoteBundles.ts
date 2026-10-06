import { useMutation, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Client bundles on a quote. Every change refreshes the quote, which carries the bundles. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.quotes.key() });
    queryClient.invalidateQueries({ queryKey: orpc.quoteBundles.key() });
  };
}

export function useSetBundleMode() {
  const onSuccess = useRefresh();
  return useMutation(orpc.quoteBundles.setMode.mutationOptions({ onSuccess }));
}
export function useSetLineCategory() {
  const onSuccess = useRefresh();
  return useMutation(orpc.quoteBundles.setLineCategory.mutationOptions({ onSuccess }));
}
export function useUpdateBundle() {
  const onSuccess = useRefresh();
  return useMutation(orpc.quoteBundles.update.mutationOptions({ onSuccess }));
}
export function useRegenerateBundle() {
  const onSuccess = useRefresh();
  return useMutation(orpc.quoteBundles.regenerate.mutationOptions({ onSuccess }));
}
/** The client PDF, as base64, with warnings for missing or out of date wording. */
export const useQuotePdf = () => useMutation(orpc.quoteBundles.pdf.mutationOptions());
