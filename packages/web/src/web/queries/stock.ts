import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "../../api";
import { orpc } from "../lib/api";

/* Warehouse stock (v3 + amendment A1): the list, an item, opening stock, receiving, the job panel and the switches. */

export type StockOverview = Awaited<ReturnType<AppRouterClient["stock"]["overview"]>>;
export type StockItemRow = StockOverview["items"][number];
export type StockPanel = Awaited<ReturnType<AppRouterClient["stock"]["jobPanel"]>>;
export type StockHold = StockPanel["holds"][number];

function useStockRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [orpc.stock.key(), orpc.clientInvoices.key(), orpc.jobs.key(), orpc.purchasing.key(), orpc.costing.key()]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

export const newRequestKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function useStockOverview(input: { q?: string; includeEnded?: boolean }) {
  return useQuery(orpc.stock.overview.queryOptions({ input, staleTime: 5_000 }));
}
export function useStockItem(id: number) {
  return useQuery(orpc.stock.item.queryOptions({ input: { id }, staleTime: 5_000 }));
}
export function useStockProducts(q: string) {
  return useQuery(orpc.stock.products.queryOptions({ input: { q }, staleTime: 30_000 }));
}
export function useStockPanel(jobId: number) {
  return useQuery(orpc.stock.jobPanel.queryOptions({ input: { jobId }, staleTime: 5_000 }));
}
export function useInvoiceStock(invoiceId: number, enabled: boolean) {
  return useQuery(orpc.stock.invoiceStock.queryOptions({ input: { invoiceId }, enabled, staleTime: 5_000 }));
}
export function useReceivable(poId: number | null) {
  return useQuery(orpc.stock.receivable.queryOptions({ input: { poId: poId ?? 0 }, enabled: !!poId, staleTime: 5_000 }));
}
export function useStockPermissions() {
  return useQuery(orpc.stock.permissions.queryOptions({ staleTime: 10_000 }));
}

/* Every stock write refreshes the stock, invoice and job views. */
export const useOpeningStock = () => useMutation(orpc.stock.openingStock.mutationOptions({ onSuccess: useStockRefresh() }));
export const useApproveItem = () => useMutation(orpc.stock.approveItem.mutationOptions({ onSuccess: useStockRefresh() }));
export const useSetCost = () => useMutation(orpc.stock.setCost.mutationOptions({ onSuccess: useStockRefresh() }));
export const useReceive = () => useMutation(orpc.stock.receive.mutationOptions({ onSuccess: useStockRefresh() }));
export const useAllocate = () => useMutation(orpc.stock.allocate.mutationOptions({ onSuccess: useStockRefresh() }));
export const useExtendHold = () => useMutation(orpc.stock.extendHold.mutationOptions({ onSuccess: useStockRefresh() }));
export const useReleaseHold = () => useMutation(orpc.stock.releaseHold.mutationOptions({ onSuccess: useStockRefresh() }));
export const useCutHold = () => useMutation(orpc.stock.cutHold.mutationOptions({ onSuccess: useStockRefresh() }));
export const usePickHold = () => useMutation(orpc.stock.pickHold.mutationOptions({ onSuccess: useStockRefresh() }));
export const useTakeOut = () => useMutation(orpc.stock.takeOut.mutationOptions({ onSuccess: useStockRefresh() }));
export const useApproveFree = () => useMutation(orpc.stock.approveFree.mutationOptions({ onSuccess: useStockRefresh() }));
export const useDeclineFree = () => useMutation(orpc.stock.declineFree.mutationOptions({ onSuccess: useStockRefresh() }));
export const useRecheck = () => useMutation(orpc.stock.recheck.mutationOptions({ onSuccess: useStockRefresh() }));
export const useRecheckAll = () => useMutation(orpc.stock.recheckAll.mutationOptions({ onSuccess: useStockRefresh() }));
export const useConfirmPayment = () => useMutation(orpc.stock.confirmPayment.mutationOptions({ onSuccess: useStockRefresh() }));
export const useCompletePercent = () => useMutation(orpc.stock.completePercent.mutationOptions({ onSuccess: useStockRefresh() }));
export const useBringIn = () => useMutation(orpc.stock.bringIn.mutationOptions({ onSuccess: useStockRefresh() }));
export const useReturnFromJob = () => useMutation(orpc.stock.returnFromJob.mutationOptions({ onSuccess: useStockRefresh() }));
export const useSetSwitch = () => useMutation(orpc.stock.setSwitch.mutationOptions({ onSuccess: useStockRefresh() }));
export const useSetCardCheck = () => useMutation(orpc.stock.setCardCheck.mutationOptions({ onSuccess: useStockRefresh() }));
export const useSaveRules = () => useMutation(orpc.stock.saveRules.mutationOptions({ onSuccess: useStockRefresh() }));
export const useSetPermission = () => useMutation(orpc.stock.setPermission.mutationOptions({ onSuccess: useStockRefresh() }));
