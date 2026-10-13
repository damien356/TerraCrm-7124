import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* The after job care series (section 18.37): the Care page and the care card on a job. */

export function useCareReport() {
  return useQuery(orpc.care.report.queryOptions({ staleTime: 20_000 }));
}

export function useCareMember(memberId: number | null) {
  return useQuery({ ...orpc.care.member.queryOptions({ input: { memberId: memberId ?? 0 } }), enabled: memberId != null });
}

export function useCareTemplates() {
  return useQuery(orpc.care.templates.queryOptions({ staleTime: 30_000 }));
}

export function useCareJob(jobId: number) {
  return useQuery({ ...orpc.care.job.queryOptions({ input: { jobId } }), enabled: jobId > 0, staleTime: 20_000 });
}

/** Every care write refreshes the whole care cache: it is small, and the page and job card share it. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.care.key() });
}

export function useCareSetMemberStatus() {
  const refresh = useRefresh();
  return useMutation(orpc.care.setMemberStatus.mutationOptions({ onSuccess: refresh }));
}

export function useCareSetOn() {
  const refresh = useRefresh();
  return useMutation(orpc.care.setOn.mutationOptions({ onSuccess: refresh }));
}

export function useCareRunNow() {
  const refresh = useRefresh();
  return useMutation(orpc.care.runNow.mutationOptions({ onSuccess: refresh }));
}

export function useCareSetWoolRanges() {
  const refresh = useRefresh();
  return useMutation(orpc.care.setWoolRanges.mutationOptions({ onSuccess: refresh }));
}

export function useCareSaveTemplate() {
  const refresh = useRefresh();
  return useMutation(orpc.care.saveTemplate.mutationOptions({ onSuccess: refresh }));
}

export function useCareResetTemplate() {
  const refresh = useRefresh();
  return useMutation(orpc.care.resetTemplate.mutationOptions({ onSuccess: refresh }));
}

export function useCareWoolAnswer() {
  const refresh = useRefresh();
  return useMutation(orpc.care.woolAnswer.mutationOptions({ onSuccess: refresh }));
}

export function useCareSetJob() {
  const refresh = useRefresh();
  return useMutation(orpc.care.setJob.mutationOptions({ onSuccess: refresh }));
}

export function useCareRetryJob() {
  const refresh = useRefresh();
  return useMutation(orpc.care.retryJob.mutationOptions({ onSuccess: refresh }));
}

export function useCarePreview() {
  return useMutation(orpc.care.preview.mutationOptions());
}

export function useCareSendTest() {
  return useMutation(orpc.care.sendTest.mutationOptions());
}
