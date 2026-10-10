import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useProductRanges(supplierId: number | null = null) {
  return useQuery(orpc.products.ranges.queryOptions({ input: { supplierId }, staleTime: 30_000 }));
}

export function useProducts(input: {
  supplierId?: number | null;
  category?: string;
  range?: string;
  search?: string;
  onSpecialOnly?: boolean;
  /** Item 9: "box", "broadloom", "none" (untagged). Empty = all. */
  soldAs?: "" | "box" | "broadloom" | "none";
}) {
  return useQuery(
    orpc.products.list.queryOptions({
      input: {
        supplierId: input.supplierId ?? null,
        category: input.category ?? "",
        range: input.range ?? "",
        search: input.search ?? "",
        onSpecialOnly: input.onSpecialOnly ?? false,
        soldAs: input.soldAs ?? "",
        limit: 2000,
      },
      staleTime: 15_000,
    }),
  );
}

export function useProduct(id: number | null) {
  return useQuery(
    orpc.products.get.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 10_000 }),
  );
}

/**
 * Prices a quantity off a roll: whether it bills at the roll rate or the cut
 * rate, and whether taking the whole roll is the cheaper move. Idle until a
 * quantity is actually typed in.
 */
export function useRollQuote(input: { id: number | null; qty: number; qtyUnit: "m2" | "lm" }) {
  return useQuery(
    orpc.products.rollQuote.queryOptions({
      input: { id: input.id ?? 0, qty: input.qty, qtyUnit: input.qtyUnit },
      enabled: input.id !== null && input.qty > 0,
      staleTime: 10_000,
    }),
  );
}

/** Live specials, what lapses soon, and what just reverted. */
export function useSpecialsBoard(endingWithinDays = 14) {
  return useQuery(orpc.products.specialsBoard.queryOptions({ input: { endingWithinDays }, staleTime: 15_000 }));
}

function useProductMutation(
  name: "specialCreate" | "specialUpdate" | "specialEnd" | "specialsExtendRange" | "setStandardPrice",
) {
  const queryClient = useQueryClient();
  return orpc.products[name].mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.products.key() }),
  });
}

export function useCreateSpecial() {
  return useMutation(useProductMutation("specialCreate"));
}
export function useUpdateSpecial() {
  return useMutation(useProductMutation("specialUpdate"));
}
/** Kills a special now. The window stays on record. */
export function useEndSpecial() {
  return useMutation(useProductMutation("specialEnd"));
}
/** Suppliers roll clearances over, so a whole range extends in one click. */
export function useExtendRangeSpecials() {
  return useMutation(useProductMutation("specialsExtendRange"));
}
export function useSetStandardPrice() {
  return useMutation(useProductMutation("setStandardPrice"));
}

export type BulkEditInput = {
  ids: number[];
  mode: "percent" | "add" | "set";
  amount: number;
  rounding: "none" | "5c" | "10c" | "dollar";
  scaleOtherRates: boolean;
};

export type BulkSpecialInput = {
  ids: number[];
  mode: "percent_off" | "dollar_off" | "set_cost";
  amount: number;
  rounding: "none" | "5c" | "10c" | "dollar";
  label: string;
  kind: "clearance" | "run_out" | "promo" | "negotiated";
  startsOn: string;
  endsOn: string;
  passOnToCustomer: boolean;
};

/** Read-only: what a bulk price change WOULD do. Writes nothing. */
export function useBulkEditPreview(input: BulkEditInput | null) {
  return useQuery(
    orpc.products.bulkPriceEditPreview.queryOptions({
      input: input ?? { ids: [0], mode: "percent", amount: 0, rounding: "none", scaleOtherRates: true },
      enabled: input !== null,
      staleTime: 0,
    }),
  );
}
export function useBulkEditApply() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.products.bulkPriceEditApply.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.products.key() }),
    }),
  );
}
export function useBulkSpecialPreview(input: BulkSpecialInput | null) {
  return useQuery(
    orpc.products.bulkSpecialPreview.queryOptions({
      input: input ?? {
        ids: [0],
        mode: "percent_off",
        amount: 0,
        rounding: "none",
        label: "Special",
        kind: "promo",
        startsOn: "2026-01-01",
        endsOn: "2026-01-01",
        passOnToCustomer: false,
      },
      enabled: input !== null,
      staleTime: 0,
    }),
  );
}
export function useBulkSpecialApply() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.products.bulkSpecialApply.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.products.key() }),
    }),
  );
}

/** Item 9: tag a product Box, Broadloom, or neither. Refreshes the price book and the Settings price list. */
export function useSetSoldAs() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.settings.productUpdate.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.products.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.settings.products.key() });
      },
    }),
  );
}
