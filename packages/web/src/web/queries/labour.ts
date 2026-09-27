import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * The labour rate book. Terra has one default per work item, an installer can
 * sit on his own number, and every rate is effective dated so old jobs keep
 * the rate of the day they were priced.
 */
export function useRateBook(input: { on?: string; search?: string; includeInactive?: boolean } = {}) {
  return useQuery(orpc.labour.book.queryOptions({ input, staleTime: 10_000 }));
}

/** One installer's card: Terra standard, his rate, the difference. */
export function useRateCard(installerId: number | null, input: { on?: string; allItems?: boolean } = {}) {
  return useQuery(
    orpc.labour.card.queryOptions({
      input: { installerId: installerId ?? 0, ...input },
      enabled: installerId != null,
      staleTime: 10_000,
    }),
  );
}

/** Every version of one item's rate, so nobody has to trust a single number. */
export function useRateHistory(itemId: number | null, installerId: number | null = null) {
  return useQuery(
    orpc.labour.history.queryOptions({
      input: { itemId: itemId ?? 0, installerId },
      enabled: itemId != null,
    }),
  );
}

function useLabourMutation(name: "setRate" | "setRates" | "clearOverride" | "itemCreate" | "itemUpdate") {
  const queryClient = useQueryClient();
  return orpc.labour[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.labour.key() });
    },
  });
}

export function useSetRate() {
  return useMutation(useLabourMutation("setRate"));
}

export function useSetRates() {
  return useMutation(useLabourMutation("setRates"));
}

export function useClearOverride() {
  return useMutation(useLabourMutation("clearOverride"));
}

export function useCreateRateItem() {
  return useMutation(useLabourMutation("itemCreate"));
}

export function useUpdateRateItem() {
  return useMutation(useLabourMutation("itemUpdate"));
}
