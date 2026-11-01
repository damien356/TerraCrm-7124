import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* The "Customer communications" card on a job (31 Oct): people, quote follow-ups, care guides, review request. */

export function useCommsPanel(jobId: number | null | undefined) {
  return useQuery(orpc.customerComms.panel.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: !!jobId, staleTime: 5_000 }));
}

export function useReviewSettings() {
  return useQuery(orpc.customerComms.reviewSettings.queryOptions({ staleTime: 30_000 }));
}

/** Every change here can change what the card, the follow-ups, care, the thread and the office tasks show. */
export function useCommsRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [orpc.customerComms.key(), orpc.quoteFollowups.key(), orpc.care.key(), orpc.conversations.key(), orpc.officeTasks.key()]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

export function useSetBuilderRef() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.setBuilderRef.mutationOptions({ onSuccess: refresh }));
}

export function useSetDirectContactOk() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.setDirectContactOk.mutationOptions({ onSuccess: refresh }));
}

export function useSaveReviewSettings() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.saveReviewSettings.mutationOptions({ onSuccess: refresh }));
}

export function useReviewSetup() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.reviewSetup.mutationOptions({ onSuccess: refresh }));
}

export function useReviewRecipient() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.reviewRecipient.mutationOptions({ onSuccess: refresh }));
}

export function useReviewWhat() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.reviewWhat.mutationOptions({ onSuccess: refresh }));
}

export function useReviewApprove() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.reviewApprove.mutationOptions({ onSuccess: refresh }));
}

export function useReviewPause() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.reviewPause.mutationOptions({ onSuccess: refresh }));
}

export function useReviewResume() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.reviewResume.mutationOptions({ onSuccess: refresh }));
}

export function useReviewRetry() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.reviewRetry.mutationOptions({ onSuccess: refresh }));
}

export function useReviewStop() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.reviewStop.mutationOptions({ onSuccess: refresh }));
}

export function useReviewReceived() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.reviewReceived.mutationOptions({ onSuccess: refresh }));
}

export function useReviewDeclined() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.reviewDeclined.mutationOptions({ onSuccess: refresh }));
}

/** Drafts only. Nothing is sent. */
export function useGuideDrafts() {
  return useMutation(orpc.customerComms.guideDrafts.mutationOptions());
}

export function useGuideSend() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.guideSend.mutationOptions({ onSuccess: refresh }));
}

export function useGuideRetry() {
  const refresh = useCommsRefresh();
  return useMutation(orpc.customerComms.guideRetry.mutationOptions({ onSuccess: refresh }));
}
