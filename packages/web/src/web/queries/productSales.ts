import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "../../api";
import { orpc } from "../lib/api";

/* Sell products (Damien, 30 Oct). The form, the sales lists and ordering on a sale. */

export type SaleInput = Parameters<AppRouterClient["productSales"]["preview"]>[0];
export type SalePreview = Awaited<ReturnType<AppRouterClient["productSales"]["preview"]>>;
export type SaleResult = Awaited<ReturnType<AppRouterClient["productSales"]["raise"]>>;
export type SaleRow = Awaited<ReturnType<AppRouterClient["productSales"]["list"]>>[number];

function useSaleRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [
      orpc.productSales.key(),
      orpc.delivery.key(),
      orpc.clientInvoices.key(),
      orpc.jobs.key(),
      orpc.quotes.key(),
      orpc.purchasing.key(),
      orpc.finance.key(),
      orpc.installerAccount.key(),
    ]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

/** What Confirm will do. Writes nothing, so it is a mutation only to run it on demand. */
export function useSalePreview() {
  return useMutation(orpc.productSales.preview.mutationOptions());
}

/** Saves the quote or raises the invoice. The same requestKey twice gives the first sale back. */
export function useRaiseSale() {
  const onSuccess = useSaleRefresh();
  return useMutation(orpc.productSales.raise.mutationOptions({ onSuccess }));
}

export function useSales(input: { installerId?: number; contactId?: number; companyId?: number }) {
  return useQuery(orpc.productSales.list.queryOptions({ input, staleTime: 10_000 }));
}

/** The sale behind a job and its order plan. Null when the job is not a product sale. */
export function useSaleForJob(jobId: number) {
  return useQuery(orpc.productSales.forJob.queryOptions({ input: { jobId }, staleTime: 10_000 }));
}

export function useSetStockAndOrder() {
  const onSuccess = useSaleRefresh();
  return useMutation(orpc.productSales.setStockAndOrder.mutationOptions({ onSuccess }));
}

/* Edit price record (Damien, 11 Nov 2026, job 188083). */
export type PriceRecord = NonNullable<Awaited<ReturnType<AppRouterClient["productSales"]["priceRecord"]>>>;
export type PriceRecordPreview = Awaited<ReturnType<AppRouterClient["productSales"]["previewPriceRecordEdit"]>>;
export type PriceRecordLineIn = Parameters<AppRouterClient["productSales"]["editPriceRecord"]>[0]["lines"][number];

/** The price record behind a Sell products invoice, whether it can change, and why not. */
export function usePriceRecord(jobId: number | null | undefined, enabled = true) {
  return useQuery(orpc.productSales.priceRecord.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: enabled && !!jobId, staleTime: 5_000 }));
}

/** What Save would change. Writes nothing. */
export function usePreviewPriceRecordEdit() {
  return useMutation(orpc.productSales.previewPriceRecordEdit.mutationOptions());
}

export function useEditPriceRecord() {
  const onSuccess = useSaleRefresh();
  return useMutation(orpc.productSales.editPriceRecord.mutationOptions({ onSuccess }));
}
