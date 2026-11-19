import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** The job's agreed price revision, earlier ones, the balance and the record form's starting figures (Damien, 18 Nov 2026). */
export function usePriceRevision(jobId: number) {
  return useQuery(orpc.priceRevisions.forJob.queryOptions({ input: { jobId }, staleTime: 10_000 }));
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.priceRevisions.key() });
    queryClient.invalidateQueries({ queryKey: orpc.clientInvoices.key() });
    queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    queryClient.invalidateQueries({ queryKey: orpc.finance.key() });
  };
}

export function useRecordPriceRevision() {
  const onSuccess = useRefresh();
  return useMutation(orpc.priceRevisions.record.mutationOptions({ onSuccess }));
}

export function useConfirmPriceRevision() {
  const onSuccess = useRefresh();
  return useMutation(orpc.priceRevisions.confirm.mutationOptions({ onSuccess }));
}

export function useWithdrawPriceRevision() {
  const onSuccess = useRefresh();
  return useMutation(orpc.priceRevisions.withdraw.mutationOptions({ onSuccess }));
}
