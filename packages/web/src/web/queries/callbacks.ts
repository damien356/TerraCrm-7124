import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useCallbackOptions() {
  return useQuery(orpc.callbacks.options.queryOptions({ staleTime: 5 * 60_000 }));
}

export function useCallbackChain(jobId: number | null) {
  return useQuery(orpc.callbacks.chain.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: jobId !== null }));
}

export function useOriginalJob(jobId: number | null) {
  return useQuery(orpc.callbacks.original.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: jobId !== null }));
}

export function useCallbackCosts(jobId: number | null) {
  return useQuery(orpc.callbacks.costs.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: jobId !== null }));
}

export function useCallbackReport(range: { from: string | null; to: string | null }) {
  return useQuery(orpc.callbacks.report.queryOptions({ input: range }));
}

function useInvalidateCallbacks() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: orpc.callbacks.key() });
    qc.invalidateQueries({ queryKey: orpc.jobs.key() });
  };
}

export function useCreateCallback() {
  const invalidate = useInvalidateCallbacks();
  return useMutation(orpc.callbacks.create.mutationOptions({ onSuccess: invalidate }));
}

export function useSetCallbackCause() {
  const invalidate = useInvalidateCallbacks();
  return useMutation(orpc.callbacks.setCause.mutationOptions({ onSuccess: invalidate }));
}

export function useSetCallbackChargeable() {
  const invalidate = useInvalidateCallbacks();
  return useMutation(orpc.callbacks.setChargeable.mutationOptions({ onSuccess: invalidate }));
}

export function useAddCallbackCost() {
  const invalidate = useInvalidateCallbacks();
  return useMutation(orpc.callbacks.addCost.mutationOptions({ onSuccess: invalidate }));
}

export function useRemoveCallbackCost() {
  const invalidate = useInvalidateCallbacks();
  return useMutation(orpc.callbacks.removeCost.mutationOptions({ onSuccess: invalidate }));
}
