import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

/* Staged jobs and progress payments (Damien, 12 Nov 2026). The job page's Stages card. */

/** The Stages card: the plan, the stages, the figures for the next invoice and the checks. */
export function useJobStages(jobId: number) {
  return useQuery(orpc.stages.forJob.queryOptions({ input: { jobId }, staleTime: 10_000 }));
}

export type StagesCard = Awaited<ReturnType<typeof client.stages.forJob>>;
export type StagePlanInput = Parameters<typeof client.stages.save>[0];

/** A first setup for the dialog. Every quantity starts in the last stage. */
export const proposeStages = (jobId: number, kind: "planned" | "hold") => client.stages.propose({ jobId, kind });

/** Preview the setup being typed. Writes nothing. */
export const previewStages = (input: StagePlanInput) => client.stages.preview(input);

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.stages.key() });
    queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    queryClient.invalidateQueries({ queryKey: orpc.finance.key() });
  };
}

export function useSaveStages() {
  const onSuccess = useRefresh();
  return useMutation(orpc.stages.save.mutationOptions({ onSuccess }));
}

export function useConfirmStages() {
  const onSuccess = useRefresh();
  return useMutation(orpc.stages.confirm.mutationOptions({ onSuccess }));
}

export function useAgreeStages() {
  const onSuccess = useRefresh();
  return useMutation(orpc.stages.agree.mutationOptions({ onSuccess }));
}

export function useCancelStages() {
  const onSuccess = useRefresh();
  return useMutation(orpc.stages.cancel.mutationOptions({ onSuccess }));
}

export function useCompleteStage() {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation(
    orpc.stages.completeStage.mutationOptions({
      onSuccess: () => {
        refresh();
        queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
      },
    }),
  );
}

export function useApproveStagePay() {
  const onSuccess = useRefresh();
  return useMutation(orpc.stages.approvePay.mutationOptions({ onSuccess }));
}

/** Raise the next progress invoice (or the Final). Then it shows on the Client invoices card for review, email and Xero. */
export function useRaiseStageInvoice() {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation(
    orpc.stages.raiseInvoice.mutationOptions({
      onSuccess: () => {
        refresh();
        queryClient.invalidateQueries({ queryKey: orpc.clientInvoices.key() });
        queryClient.invalidateQueries({ queryKey: orpc.delivery.key() });
        queryClient.invalidateQueries({ queryKey: orpc.quoteSend.key() });
      },
    }),
  );
}

export function useReassignRemaining() {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation(
    orpc.stages.reassign.mutationOptions({
      onSuccess: () => {
        refresh();
        queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
      },
    }),
  );
}
