import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Trade sales (notes 18.65). Admin only. Every mutation invalidates the trade,
 * settlement and installer bill keys, because one offset or payment moves all
 * three. The server re-reads balances on every write, so a stale screen can
 * never save a wrong figure: it gets "The figures changed" and reloads.
 */

function useInvalidateTrade() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: orpc.trade.key() });
    qc.invalidateQueries({ queryKey: orpc.tradeSettle.key() });
    qc.invalidateQueries({ queryKey: orpc.installerInvoices.key() });
    qc.invalidateQueries({ queryKey: orpc.finance.key() });
  };
}

/** One click, one key. A retry of the same click sends the same key, so the server saves it once. */
export const newKey = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/* -------------------------------- reads -------------------------------- */

export const useTradeSettings = () => useQuery(orpc.trade.settings.queryOptions({ staleTime: 30_000 }));

export const useTradeProducts = (input: { search?: string; listedOnly?: boolean; buyerId?: number; limit?: number }, enabled = true) =>
  useQuery(orpc.trade.products.queryOptions({ input, staleTime: 15_000, enabled }));

export const useLastPrices = (productId: number | null, buyerId: number | null) =>
  useQuery(orpc.trade.lastPrices.queryOptions({ input: { productId: productId ?? 0, buyerId }, enabled: !!productId, staleTime: 30_000 }));

export const useTradeBuyers = () => useQuery(orpc.trade.buyers.queryOptions({ staleTime: 15_000 }));

export const useBuyerCard = (kind: "installer" | "contact" | "company", refId: number) =>
  useQuery(orpc.trade.buyerCard.queryOptions({ input: { kind, refId }, staleTime: 15_000 }));

export const useTradeSales = (input: { buyerId?: number; status?: "draft" | "finalised" | "cancelled" }) =>
  useQuery(orpc.trade.sales.queryOptions({ input, staleTime: 10_000 }));

export const useTradeSale = (saleId: number) => useQuery(orpc.trade.sale.queryOptions({ input: { saleId }, staleTime: 5_000 }));

export const useStockLevels = (productIds: number[] = []) => useQuery(orpc.trade.stock.queryOptions({ input: { productIds }, staleTime: 10_000 }));

export const useMovements = (productId: number | null) =>
  useQuery(orpc.trade.movements.queryOptions({ input: { productId: productId ?? 0 }, enabled: !!productId, staleTime: 10_000 }));

export const useTradeCashTotals = (from: string, to: string) => useQuery(orpc.finance.tradeReceipts.queryOptions({ input: { from, to }, staleTime: 30_000 }));

export const useAgreements = (installerId: number) => useQuery(orpc.tradeSettle.agreements.queryOptions({ input: { installerId }, staleTime: 15_000 }));

export const useOpenOffsets = () => useQuery(orpc.tradeSettle.openOffsets.queryOptions({ staleTime: 10_000 }));

export const useBillsForOffset = (saleId: number, enabled: boolean) =>
  useQuery(orpc.tradeSettle.billsForOffset.queryOptions({ input: { saleId }, enabled, staleTime: 5_000 }));

export const useBillSettlement = (billId: number | null) =>
  useQuery(orpc.tradeSettle.bill.queryOptions({ input: { billId: billId ?? 0 }, enabled: !!billId, staleTime: 5_000 }));

/* ------------------------------- writes -------------------------------- */

export function useSaveTradeSettings() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.saveSettings.mutationOptions({ onSuccess: done }));
}
export function useSaveProductRule() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.saveProductRule.mutationOptions({ onSuccess: done }));
}
export function useSaveBuyer() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.saveBuyer.mutationOptions({ onSuccess: done }));
}
export function useVerifyEntity() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.verifyEntity.mutationOptions({ onSuccess: done }));
}
export function useCreateDraft() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.createDraft.mutationOptions({ onSuccess: done }));
}
export function useEditDraft() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.editDraft.mutationOptions({ onSuccess: done }));
}
export function useFinalise() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.finalise.mutationOptions({ onSuccess: done }));
}
export function useCancelSale() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.cancel.mutationOptions({ onSuccess: done }));
}
export const useInvoicePdf = () => useMutation(orpc.trade.invoicePdf.mutationOptions());
export const useCreditPdf = () => useMutation(orpc.trade.creditPdf.mutationOptions());
export function useSendInvoice() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.send.mutationOptions({ onSuccess: done }));
}
export function useSendCredit() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.sendCredit.mutationOptions({ onSuccess: done }));
}
export function useRecordPayment() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.recordPayment.mutationOptions({ onSuccess: done }));
}
export function useRecordRefund() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.recordRefund.mutationOptions({ onSuccess: done }));
}
export function useKeepAsCredit() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.keepAsCredit.mutationOptions({ onSuccess: done }));
}
export function useApplyCredit() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.applyCredit.mutationOptions({ onSuccess: done }));
}
export function useReversePayment() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.reversePayment.mutationOptions({ onSuccess: done }));
}
export function useCreateCredit() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.createCredit.mutationOptions({ onSuccess: done }));
}
export function useSetArrangement() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.setArrangement.mutationOptions({ onSuccess: done }));
}
export function useFulfil() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.fulfil.mutationOptions({ onSuccess: done }));
}
export function useSetFulfilmentMethod() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.setFulfilmentMethod.mutationOptions({ onSuccess: done }));
}
export function useRecordReturn() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.recordReturn.mutationOptions({ onSuccess: done }));
}
export function usePostStock() {
  const done = useInvalidateTrade();
  return useMutation(orpc.trade.postStock.mutationOptions({ onSuccess: done }));
}

/* ----------------------------- settlements ----------------------------- */

export function useAddAgreement() {
  const done = useInvalidateTrade();
  return useMutation(orpc.tradeSettle.addAgreement.mutationOptions({ onSuccess: done }));
}
export function useArchiveAgreement() {
  const done = useInvalidateTrade();
  return useMutation(orpc.tradeSettle.archiveAgreement.mutationOptions({ onSuccess: done }));
}
export const useAgreementUrl = () => useMutation(orpc.tradeSettle.agreementUrl.mutationOptions());
export const useOffsetFileUrl = () => useMutation(orpc.tradeSettle.offsetFileUrl.mutationOptions());
export function useProposeOffset() {
  const done = useInvalidateTrade();
  return useMutation(orpc.tradeSettle.propose.mutationOptions({ onSuccess: done }));
}
export function useApproveOffset() {
  const done = useInvalidateTrade();
  return useMutation(orpc.tradeSettle.approve.mutationOptions({ onSuccess: done }));
}
export function useConfirmOffset() {
  const done = useInvalidateTrade();
  return useMutation(orpc.tradeSettle.confirm.mutationOptions({ onSuccess: done }));
}
export function useCancelOffset() {
  const done = useInvalidateTrade();
  return useMutation(orpc.tradeSettle.cancel.mutationOptions({ onSuccess: done }));
}
export function useReverseOffset() {
  const done = useInvalidateTrade();
  return useMutation(orpc.tradeSettle.reverse.mutationOptions({ onSuccess: done }));
}
export const useRemittancePdf = () => useMutation(orpc.tradeSettle.remittancePdf.mutationOptions());
export function useSendRemittance() {
  const done = useInvalidateTrade();
  return useMutation(orpc.tradeSettle.sendRemittance.mutationOptions({ onSuccess: done }));
}

/* ------------------------------ public pay ----------------------------- */

export const useTradePayState = (token: string) => useQuery(orpc.publicPages.tradePay.get.queryOptions({ input: { token }, retry: false }));
export const useTradeCheckout = () => useMutation(orpc.publicPages.tradePay.checkout.mutationOptions());
export const useTradeConfirm = () => useMutation(orpc.publicPages.tradePay.confirm.mutationOptions());
