import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* Client prep messages (notes 18.56): the job's panel, Settings, and the To fill page. */

export function usePrepPlan(jobId: number) {
  return useQuery(orpc.prep.plan.queryOptions({ input: { jobId }, staleTime: 5_000 }));
}

export function usePrepSettings() {
  return useQuery(orpc.prep.settingsGet.queryOptions({ staleTime: 10_000 }));
}

export function usePrepToFill() {
  return useQuery(orpc.prep.toFill.queryOptions({ staleTime: 10_000 }));
}

/** Everything that changes what the panel shows: the plan, the job, its timeline and messages. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [orpc.prep.key(), orpc.jobs.key(), orpc.conversations.key()]) queryClient.invalidateQueries({ queryKey: key });
  };
}

export function usePrepStop() {
  const refresh = useRefresh();
  return useMutation(orpc.prep.stop.mutationOptions({ onSuccess: refresh }));
}

export function usePrepUnstop() {
  const refresh = useRefresh();
  return useMutation(orpc.prep.unstop.mutationOptions({ onSuccess: refresh }));
}

export function usePrepRetry() {
  const refresh = useRefresh();
  return useMutation(orpc.prep.retry.mutationOptions({ onSuccess: refresh }));
}

export function usePrepOnMyWay() {
  const refresh = useRefresh();
  return useMutation(orpc.prep.onMyWay.mutationOptions({ onSuccess: refresh }));
}

export function useSetPrepOn() {
  const refresh = useRefresh();
  return useMutation(orpc.prep.setPrepOn.mutationOptions({ onSuccess: refresh }));
}

export function usePrepTickApt() {
  const refresh = useRefresh();
  return useMutation(orpc.prep.tickApt.mutationOptions({ onSuccess: refresh }));
}

export function useSavePrepSettings() {
  const refresh = useRefresh();
  return useMutation(orpc.prep.settingsSave.mutationOptions({ onSuccess: refresh }));
}
