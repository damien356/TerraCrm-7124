import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Whether the job is supply only, and whether it has been marked delivered. */
export function useDeliveryStatus(jobId: number) {
  return useQuery(orpc.delivery.status.queryOptions({ input: { jobId }, staleTime: 10_000 }));
}

/** Files the proof, completes the job and raises the final invoice. */
export function useMarkDelivered() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.delivery.markDelivered.mutationOptions({
      onSuccess: () => {
        for (const key of [orpc.delivery.key(), orpc.clientInvoices.key(), orpc.jobs.key(), orpc.media.key(), orpc.finance.key()]) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      },
    }),
  );
}

/** Goods delivered or collected, all of it or part. Never changes what is paid. */
export function useRecordHandover() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.delivery.recordHandover.mutationOptions({
      onSuccess: () => {
        for (const key of [orpc.delivery.key(), orpc.productSales.key(), orpc.clientInvoices.key(), orpc.jobs.key(), orpc.media.key(), orpc.finance.key()]) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      },
    }),
  );
}
