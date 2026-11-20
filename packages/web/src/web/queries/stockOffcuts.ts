import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "../../api";
import { orpc } from "../lib/api";

/* Underlay offcuts on the job page (Damien, 20 Nov 2026). */

export type JobOffcuts = Awaited<ReturnType<AppRouterClient["stockOffcuts"]["forJob"]>>;
export type MaterialOffcuts = JobOffcuts["materials"][number];

function useOffcutRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [orpc.stockOffcuts.key(), orpc.stock.key(), orpc.clientInvoices.key(), orpc.jobs.key(), orpc.purchasing.key(), orpc.costing.key()]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

export function useJobOffcuts(jobId: number) {
  return useQuery(orpc.stockOffcuts.forJob.queryOptions({ input: { jobId }, enabled: jobId > 0, staleTime: 5_000 }));
}

/** Stock locations for the "Offcut came back" dialog. Only loads while it is open. */
export function useStockLocations(enabled: boolean) {
  return useQuery(orpc.stock.overview.queryOptions({ input: {}, enabled, staleTime: 60_000, select: (o) => o.locations }));
}

export const useAutoApplyOffcuts = () => useMutation(orpc.stockOffcuts.autoApply.mutationOptions({ onSuccess: useOffcutRefresh() }));
export const useUseOffcut = () => useMutation(orpc.stockOffcuts.use.mutationOptions({ onSuccess: useOffcutRefresh() }));
export const useUndoOffcut = () => useMutation(orpc.stockOffcuts.undo.mutationOptions({ onSuccess: useOffcutRefresh() }));
export const useIssueOffcut = () => useMutation(orpc.stockOffcuts.issue.mutationOptions({ onSuccess: useOffcutRefresh() }));
export const useRecordOffcut = () => useMutation(orpc.stockOffcuts.record.mutationOptions({ onSuccess: useOffcutRefresh() }));
