import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Whether a quote with a delivery line still needs a site, and a guess at it from the line. */
export function useQuoteSiteNeed(quoteId: number | null) {
  return useQuery({ ...orpc.siteFill.forQuote.queryOptions({ input: { quoteId: quoteId ?? 0 } }), enabled: !!quoteId });
}

/** Whether a job has no site, and a guess at it from its quote's delivery line. */
export function useJobSiteNeed(jobId: number) {
  return useQuery(orpc.siteFill.forJob.queryOptions({ input: { jobId } }));
}

/** Saves the site on the quote and its job, or on the job and its open quotes. */
export function useSaveSiteFill() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.siteFill.save.mutationOptions({
      onSuccess: () => {
        for (const key of [orpc.siteFill.key(), orpc.quotes.key(), orpc.jobs.key(), orpc.sites.key()]) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      },
    }),
  );
}

/** What changing a job's address would touch: other jobs at the site, booked crew, POs, SWMS. */
export function useJobSiteChangeInfo(jobId: number, enabled: boolean) {
  return useQuery({ ...orpc.siteFill.changeInfo.queryOptions({ input: { jobId } }), enabled });
}

/** Corrects the site's address, or moves the job to a different site. */
export function useChangeJobSite() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.siteFill.change.mutationOptions({
      onSuccess: () => {
        for (const key of [orpc.siteFill.key(), orpc.quotes.key(), orpc.jobs.key(), orpc.sites.key(), orpc.purchasing.key()]) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      },
    }),
  );
}
