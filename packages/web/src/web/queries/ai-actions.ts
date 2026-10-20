import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Step 1: what the helpers want a person to look at. Polls so new items show without a reload. */
export const useAiTray = () => useQuery(orpc.aiActions.tray.queryOptions({ staleTime: 15_000, refetchInterval: 60_000 }));

export const useAiTrayCount = () => useQuery(orpc.aiActions.count.queryOptions({ staleTime: 30_000, refetchInterval: 120_000 }));

export type AiAgentFilter = "purchasing" | "invoices" | "mail" | null;

/** Everything the helpers did, newest first, 50 at a time. */
export const useAiLog = (agent: AiAgentFilter) =>
  useInfiniteQuery(
    orpc.aiActions.log.infiniteOptions({
      input: (before: number | null) => ({ agent, before }),
      initialPageParam: null as number | null,
      getNextPageParam: (last) => last.nextBefore,
    }),
  );

export const useResolveAiActions = () => {
  const qc = useQueryClient();
  return useMutation(orpc.aiActions.resolve.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: orpc.aiActions.key() }) }));
};
