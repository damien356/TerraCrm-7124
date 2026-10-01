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

/**
 * The rate book as a quoting list: standard rate, sell price, and who lays it.
 * Category toggle and free text search both narrow the same list.
 */
export function useRatePicker(input: { groupName?: string; search?: string; includeUnpriced?: boolean } = {}) {
  return useQuery(
    orpc.labour.picker.queryOptions({
      input: {
        groupName: input.groupName ?? "",
        search: input.search ?? "",
        includeUnpriced: input.includeUnpriced ?? false,
      },
      staleTime: 15_000,
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

/** Every labour write refreshes the rate book, the cards and the quote picker. */
function useRefreshLabour() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.labour.key() });
}

export function useSetRate() {
  const onSuccess = useRefreshLabour();
  return useMutation(orpc.labour.setRate.mutationOptions({ onSuccess }));
}

export function useSetRates() {
  const onSuccess = useRefreshLabour();
  return useMutation(orpc.labour.setRates.mutationOptions({ onSuccess }));
}

export function useClearOverride() {
  const onSuccess = useRefreshLabour();
  return useMutation(orpc.labour.clearOverride.mutationOptions({ onSuccess }));
}

export function useCreateRateItem() {
  const onSuccess = useRefreshLabour();
  return useMutation(orpc.labour.itemCreate.mutationOptions({ onSuccess }));
}

export function useUpdateRateItem() {
  const onSuccess = useRefreshLabour();
  return useMutation(orpc.labour.itemUpdate.mutationOptions({ onSuccess }));
}

export function useDeleteRateItem() {
  const onSuccess = useRefreshLabour();
  return useMutation(orpc.labour.itemDelete.mutationOptions({ onSuccess }));
}
