import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* The no-login client pages. Each call carries only the link token. */

export function usePublicQuote(token: string) {
  // One fetch per visit: a refetch on focus would count another view.
  return useQuery(
    orpc.publicPages.quote.get.queryOptions({
      input: { token },
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    }),
  );
}

export const usePublicQuotePdf = () => useMutation(orpc.publicPages.quote.pdf.mutationOptions());

export function useAcceptQuoteOnline() {
  return useMutation(orpc.publicPages.quote.accept.mutationOptions());
}

export function usePublicSelection(token: string) {
  return useQuery(
    orpc.publicPages.selection.get.queryOptions({ input: { token }, refetchOnWindowFocus: false, retry: false }),
  );
}

export function useSubmitSelection() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.publicPages.selection.submit.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.publicPages.selection.key() }),
    }),
  );
}

/* Pay by card (/pay/<token>). The page reads the invoice, Stripe takes the card. */
export function usePublicPay(token: string) {
  return useQuery(orpc.publicPages.pay.get.queryOptions({ input: { token }, refetchOnWindowFocus: false, retry: false }));
}

export const useStartCardPayment = () => useMutation(orpc.publicPages.pay.checkout.mutationOptions());

export function useConfirmCardPayment() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.publicPages.pay.confirm.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.publicPages.pay.key() }),
    }),
  );
}

/* A variation (/v/<token>, item 12). Read, sign and accept, or decline. */
export function usePublicVariation(token: string) {
  // One fetch per visit: a refetch on focus would count another view.
  return useQuery(
    orpc.publicPages.variation.get.queryOptions({
      input: { token },
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    }),
  );
}

export const usePublicVariationPdf = () => useMutation(orpc.publicPages.variation.pdf.mutationOptions());
export const useAcceptVariationOnline = () => useMutation(orpc.publicPages.variation.accept.mutationOptions());
export const useDeclineVariationOnline = () => useMutation(orpc.publicPages.variation.decline.mutationOptions());
