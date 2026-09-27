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
    | "updateItem"
    | "removeItem"
    | "reorderItems"
    | "send"
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
export function useUpdateQuoteItem() {
  return useMutation(useQuoteMutation("updateItem"));
}
export function useRemoveQuoteItem() {
  return useMutation(useQuoteMutation("removeItem"));
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
