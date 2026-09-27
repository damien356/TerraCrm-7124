import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function usePendingOffers() {
  return useQuery(orpc.offers.pending.queryOptions({ staleTime: 15_000, refetchInterval: 45_000 }));
}

export function useOffersForTask(taskId: number | null) {
  return useQuery(
    orpc.offers.forTask.queryOptions({
      input: { taskId: taskId ?? 0 },
      enabled: taskId !== null,
      staleTime: 10_000,
    }),
  );
}

export function useDeclines() {
  return useQuery(orpc.offers.declines.queryOptions({ staleTime: 30_000 }));
}

function useOfferMutation(name: "sendDirect" | "broadcast" | "withdraw") {
  const queryClient = useQueryClient();
  return orpc.offers[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.offers.key() });
      queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
      queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() });
    },
  });
}

/** Direct offer to one installer. */
export function useSendDirect() {
  return useMutation(useOfferMutation("sendDirect"));
}
/** Broadcast to everyone ticked for the skill — first to accept wins. */
export function useBroadcast() {
  return useMutation(useOfferMutation("broadcast"));
}
export function useWithdrawOffers() {
  return useMutation(useOfferMutation("withdraw"));
}
