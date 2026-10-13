import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Settings, Business rules: which underlay upgrades to which (fix list item 9). Admin only. */
export function useUnderlayUpgrades() {
  return useQuery(orpc.underlayUpgrades.get.queryOptions({ staleTime: 30_000 }));
}

export function useSaveUnderlayUpgrades() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.underlayUpgrades.save.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.underlayUpgrades.key() }),
    }),
  );
}
