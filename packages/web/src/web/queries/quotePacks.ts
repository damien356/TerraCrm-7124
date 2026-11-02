import { useMutation, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Pack name (2 Nov). Whether a sheet, carton or bag line shows m² or packs
 * on the client copy. Refreshes the quote and its client bundles.
 */
export function useSetClientPacks() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.quotePacks.setClientPacks.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.quotes.key() });
        queryClient.invalidateQueries({ queryKey: orpc.quoteBundles.key() });
      },
    }),
  );
}
