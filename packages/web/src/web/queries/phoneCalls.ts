import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* AI phone calls and routing (Retell, 5 Nov). */

export function usePhoneStatus() {
  return useQuery(orpc.phoneCalls.status.queryOptions({ staleTime: 30_000, retry: false }));
}

export function usePhoneConfig() {
  return useQuery(orpc.phoneCalls.config.queryOptions({ staleTime: 30_000, retry: false }));
}

export function usePhoneFollowups(scope: "mine" | "queue" | "open" | "resolved" | "all", enabled = true) {
  return useQuery(orpc.phoneCalls.followups.queryOptions({ input: { scope }, enabled, staleTime: 10_000, refetchInterval: 60_000, retry: false }));
}

export function usePhoneFollowup(id: number | null) {
  return useQuery(orpc.phoneCalls.followup.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, retry: false }));
}

export function usePhoneCallList(enabled = true) {
  return useQuery(orpc.phoneCalls.calls.queryOptions({ input: { limit: 100 }, enabled, staleTime: 15_000, refetchInterval: 60_000, retry: false }));
}

export function usePhoneCall(id: number | null, withTranscript = false) {
  return useQuery(orpc.phoneCalls.call.queryOptions({ input: { id: id ?? 0, withTranscript }, enabled: id !== null, retry: false }));
}

export function usePhoneCovers(enabled = true) {
  return useQuery(orpc.phoneCalls.covers.queryOptions({ enabled, retry: false }));
}

export function usePhoneForJob(jobId: number) {
  return useQuery(orpc.phoneCalls.forJob.queryOptions({ input: { jobId }, staleTime: 30_000, retry: false }));
}

export function usePhoneForContact(contactId: number) {
  return useQuery(orpc.phoneCalls.forContact.queryOptions({ input: { contactId }, staleTime: 30_000, retry: false }));
}

export function useJobManager(jobId: number) {
  return useQuery(orpc.phoneCalls.jobManager.queryOptions({ input: { jobId }, staleTime: 60_000, retry: false }));
}

function useInvalidatePhone() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: orpc.phoneCalls.key() });
  };
}

export function useSavePhoneConfig() {
  const invalidate = useInvalidatePhone();
  return useMutation(orpc.phoneCalls.saveConfig.mutationOptions({ onSuccess: invalidate }));
}

/** The routing test writes nothing, so it is a mutation only to run on a button press. */
export function useTestRoute() {
  return useMutation(orpc.phoneCalls.testRoute.mutationOptions());
}

export function useClaimFollowup() {
  const invalidate = useInvalidatePhone();
  return useMutation(orpc.phoneCalls.claim.mutationOptions({ onSuccess: invalidate }));
}

export function useAssignFollowup() {
  const invalidate = useInvalidatePhone();
  return useMutation(orpc.phoneCalls.assign.mutationOptions({ onSuccess: invalidate }));
}

export function useStartFollowup() {
  const invalidate = useInvalidatePhone();
  return useMutation(orpc.phoneCalls.start.mutationOptions({ onSuccess: invalidate }));
}

export function useResolveFollowup() {
  const invalidate = useInvalidatePhone();
  return useMutation(orpc.phoneCalls.resolve.mutationOptions({ onSuccess: invalidate }));
}

export function useReopenFollowup() {
  const invalidate = useInvalidatePhone();
  return useMutation(orpc.phoneCalls.reopen.mutationOptions({ onSuccess: invalidate }));
}

export function useAddCover() {
  const invalidate = useInvalidatePhone();
  return useMutation(orpc.phoneCalls.addCover.mutationOptions({ onSuccess: invalidate }));
}

export function useCancelCover() {
  const invalidate = useInvalidatePhone();
  return useMutation(orpc.phoneCalls.cancelCover.mutationOptions({ onSuccess: invalidate }));
}

export function useSetJobManager() {
  const qc = useQueryClient();
  return useMutation(
    orpc.phoneCalls.setJobManager.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: orpc.phoneCalls.key() });
        qc.invalidateQueries({ queryKey: orpc.jobs.key() });
      },
    }),
  );
}
