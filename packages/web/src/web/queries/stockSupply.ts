import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "../../api";
import { orpc } from "../lib/api";

/* A2: supply settings, the Reorder list, warehouse orders, and container / stock-only shortages on quotes and sales. */

export type ReorderList = Awaited<ReturnType<AppRouterClient["stockSupply"]["reorderList"]>>;
export type ReorderSupplier = ReorderList["suppliers"][number];
export type ReorderProduct = ReorderSupplier["products"][number];
export type ReorderShortage = ReorderProduct["shortages"][number];
export type WarehouseOrder = ReorderList["orders"][number];
export type SupplySettings = ReorderProduct["settings"];
export type ReviewList = Awaited<ReturnType<AppRouterClient["stockSupply"]["reviewList"]>>;
export type SupplyProduct = Awaited<ReturnType<AppRouterClient["stockSupply"]["products"]>>[number];
export type SupplyShortRow = Awaited<ReturnType<AppRouterClient["stockSupply"]["quoteSupply"]>>["shorts"][number];

function useSupplyRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [orpc.stockSupply.key(), orpc.stock.key(), orpc.purchasing.key(), orpc.payables.key(), orpc.finance.key(), orpc.jobs.key()]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

export function useReorderList() {
  // Admin only: a refusal is shown straight away, not retried.
  return useQuery(orpc.stockSupply.reorderList.queryOptions({ staleTime: 5_000, retry: false }));
}
export function useSupplyReview(enabled: boolean) {
  return useQuery(orpc.stockSupply.reviewList.queryOptions({ enabled, staleTime: 10_000 }));
}
export function useSupplyProducts(q: string) {
  return useQuery(orpc.stockSupply.products.queryOptions({ input: { q }, enabled: q.trim().length >= 2, staleTime: 30_000 }));
}
export function useQuoteSupply(quoteId: number, enabled = true) {
  return useQuery(orpc.stockSupply.quoteSupply.queryOptions({ input: { quoteId }, enabled, staleTime: 5_000 }));
}

/* Every write refreshes the Reorder list, stock, purchasing, payables and the forecast. */
export const useSaveSupply = () => useMutation(orpc.stockSupply.saveSupply.mutationOptions({ onSuccess: useSupplyRefresh() }));
export const useDraftSuggestions = () => useMutation(orpc.stockSupply.draftSuggestions.mutationOptions({ onSuccess: useSupplyRefresh() }));
export const useEditDraftLine = () => useMutation(orpc.stockSupply.editDraftLine.mutationOptions({ onSuccess: useSupplyRefresh() }));
export const useEditTerms = () => useMutation(orpc.stockSupply.editTerms.mutationOptions({ onSuccess: useSupplyRefresh() }));
export const useToWarehouse = () => useMutation(orpc.stockSupply.toWarehouse.mutationOptions({ onSuccess: useSupplyRefresh() }));
export const useToJobPo = () => useMutation(orpc.stockSupply.toJobPo.mutationOptions({ onSuccess: useSupplyRefresh() }));
export const useRemoveLink = () => useMutation(orpc.stockSupply.removeLink.mutationOptions({ onSuccess: useSupplyRefresh() }));
export const useCloseLine = () => useMutation(orpc.stockSupply.closeLine.mutationOptions({ onSuccess: useSupplyRefresh() }));
export const useApproveShort = () => useMutation(orpc.stockSupply.approveShort.mutationOptions({ onSuccess: useSupplyRefresh() }));
export const useCustomerArrangement = () => useMutation(orpc.stockSupply.customerArrangement.mutationOptions({ onSuccess: useSupplyRefresh() }));
