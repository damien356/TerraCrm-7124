import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** The ServiceM8 import review queue — what is a homeowner, what is a business. */
export function useReviewStats() {
  return useQuery(orpc.review.stats.queryOptions({ staleTime: 10_000 }));
}

export function useReviewQueue(
  input: { search?: string; resolved?: boolean; sort?: "jobs" | "recent" | "name"; limit?: number } = {},
) {
  return useQuery(orpc.review.queue.queryOptions({ input, staleTime: 5_000 }));
}

function useReviewMutation(name: "resolve" | "setCompanyBlock") {
  const queryClient = useQueryClient();
  return orpc.review[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.review.key() });
      queryClient.invalidateQueries({ queryKey: orpc.contacts.key() });
      queryClient.invalidateQueries({ queryKey: orpc.companies.key() });
      queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    },
  });
}

export function useResolveReview() {
  return useMutation(useReviewMutation("resolve"));
}

export function useSetCompanyBlock() {
  return useMutation(useReviewMutation("setCompanyBlock"));
}
