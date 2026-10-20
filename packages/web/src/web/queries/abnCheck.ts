import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Notes 18.64: what the ABN register says for an ABN being typed. Saves nothing. Admin only. */
export function useAbnLookup(input: { abn: string }, enabled: boolean) {
  return useQuery(orpc.abnCheck.lookup.queryOptions({ input, enabled, staleTime: 5 * 60_000, retry: false }));
}

/** Every current installer whose ABN is missing or doesn't pass. Admin only. */
export function useAbnChaseList() {
  return useQuery(orpc.abnCheck.chaseList.queryOptions({ staleTime: 30_000 }));
}

/** Look a saved ABN up again now. */
export function useAbnRecheck() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.abnCheck.check.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.installers.key() });
        queryClient.invalidateQueries({ queryKey: orpc.abnCheck.key() });
      },
    }),
  );
}
