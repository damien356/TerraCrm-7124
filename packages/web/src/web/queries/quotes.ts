import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useQuotes(input: { search?: string; status?: string; contactId?: number } = {}) {
  return useQuery(orpc.quotes.list.queryOptions({ input, staleTime: 20_000 }));
}

export function useQuote(id: number | null) {
  return useQuery(
    orpc.quotes.get.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 5_000 }),
  );
}

/** What deposit % a new quote for this company or contact starts at. */
export function useDepositDefault(input: { companyId: number | null; contactId: number | null }) {
  return useQuery(orpc.quotes.depositDefault.queryOptions({ input, staleTime: 10_000 }));
}

export function useQuoteStats() {
  return useQuery(orpc.quotes.stats.queryOptions({ staleTime: 30_000 }));
}

function useQuoteMutation(
  name:
    | "create"
    | "update"
    | "remove"
    | "addItem"
    | "addProduct"
    | "addLabour"
    | "updateItem"
    | "removeItem"
    | "reorderItems"
    | "send"
    | "approveDiscount"
    | "accept"
    | "decline"
    | "revise"
    | "convertToJob",
) {
  const queryClient = useQueryClient();
  return orpc.quotes[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.quotes.key() });
      queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
      queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
    },
  });
}

export function useCreateQuote() {
  return useMutation(useQuoteMutation("create"));
}
/** Create quote on the job page: what it can offer (open draft, copy latest, blank). */
export function useQuoteJobStart(jobId: number, enabled: boolean) {
  return useQuery(orpc.quotes.jobStart.queryOptions({ input: { jobId }, enabled, staleTime: 0 }));
}
export function useCreateQuoteForJob() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.quotes.createForJob.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.quotes.key() });
        queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
        queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
      },
    }),
  );
}
export function useUpdateQuote() {
  return useMutation(useQuoteMutation("update"));
}
export function useRemoveQuote() {
  return useMutation(useQuoteMutation("remove"));
}
export function useAddQuoteItem() {
  return useMutation(useQuoteMutation("addItem"));
}
export function useAddQuoteProduct() {
  return useMutation(useQuoteMutation("addProduct"));
}
/** A labour line off the rate book. The rate is resolved on the server. */
export function useAddQuoteLabour() {
  return useMutation(useQuoteMutation("addLabour"));
}
export function useUpdateQuoteItem() {
  return useMutation(useQuoteMutation("updateItem"));
}
export function useRemoveQuoteItem() {
  return useMutation(useQuoteMutation("removeItem"));
}
export function useApproveDiscount() {
  return useMutation(useQuoteMutation("approveDiscount"));
}
export function useSendQuote() {
  return useMutation(useQuoteMutation("send"));
}
export function useAcceptQuote() {
  return useMutation(useQuoteMutation("accept"));
}
export function useDeclineQuote() {
  return useMutation(useQuoteMutation("decline"));
}
export function useReviseQuote() {
  return useMutation(useQuoteMutation("revise"));
}
/** Accepted quote → job, with labour lines becoming unassigned tasks. */
export function useConvertQuote() {
  return useMutation(useQuoteMutation("convertToJob"));
}

/** Swap the product on a line; name, unit and price come off the price book. */
export function useChangeQuoteProduct() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.quotes.changeProduct.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.quotes.key() }),
    }),
  );
}

/** The closest products to what a line says, for Change product. */
export function useSuggestedProducts(itemId: number, enabled: boolean) {
  return useQuery(orpc.quotes.suggestProducts.queryOptions({ input: { itemId }, enabled, staleTime: 30_000 }));
}

/** What was said about the customer on a quote with nobody on it, and the closest clients. */
export function useQuoteCustomerHelp(id: number, enabled: boolean) {
  return useQuery(orpc.quotes.customerHelp.queryOptions({ input: { id }, enabled, staleTime: 30_000 }));
}

export function useSetQuoteCustomer() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.quotes.setCustomer.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.quotes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.contacts.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.voiceQuotes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.memos.key() }),
        ]),
    }),
  );
}
