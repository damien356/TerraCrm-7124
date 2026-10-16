import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Copy from previous job and Duplicate this quote (notes 18.46). */
export function useCopySearch(input: { q: string; contactId?: number | null; companyId?: number | null }, enabled = true) {
  return useQuery(orpc.quoteCopy.search.queryOptions({ input, enabled, staleTime: 10_000 }));
}

/** The old quote's lines with their ticks, today's prices and red lines. */
export function useCopyPreview(quoteId: number | null) {
  return useQuery(
    orpc.quoteCopy.preview.queryOptions({ input: { quoteId: quoteId ?? 0 }, enabled: quoteId != null, staleTime: 0 }),
  );
}

export function useCopyCreate() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.quoteCopy.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.quotes.key() });
        queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
        queryClient.invalidateQueries({ queryKey: orpc.quoteCopy.key() });
      },
    }),
  );
}

/** Job page: where its quotes came from and where they were copied to. */
export function useCopyLinksForJob(jobId: number | null) {
  return useQuery(orpc.quoteCopy.forJob.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: jobId != null, staleTime: 10_000 }));
}

/** Client record: quotes with their copies grouped under the original. */
export function useQuotesForClient(input: { contactId?: number | null; companyId?: number | null }) {
  return useQuery(
    orpc.quoteCopy.forClient.queryOptions({
      input,
      enabled: input.contactId != null || input.companyId != null,
      staleTime: 10_000,
    }),
  );
}
