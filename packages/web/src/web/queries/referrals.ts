import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Referral fees (notes 18.47). Everything is Admin only except the picker on
 * a job: useReferrerPickList, useJobReferral and useSetJobReferral, which give
 * Office the names and nothing else.
 */

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: orpc.referrals.key() });
    qc.invalidateQueries({ queryKey: orpc.quotes.key() });
    qc.invalidateQueries({ queryKey: orpc.variations.key() });
    qc.invalidateQueries({ queryKey: orpc.jobs.key() });
    qc.invalidateQueries({ queryKey: orpc.officeTasks.key() });
    qc.invalidateQueries({ queryKey: orpc.intel.key() });
  };
}

export type CardKey = { companyId?: number; contactId?: number };

export function useReferrerCard(key: CardKey, enabled = true) {
  return useQuery(orpc.referrals.card.queryOptions({ input: key, enabled, staleTime: 30_000 }));
}

export function useSaveReferrerCard() {
  const onSuccess = useRefresh();
  return useMutation(orpc.referrals.saveCard.mutationOptions({ onSuccess }));
}

export function useReferrerPickList(enabled = true) {
  return useQuery(orpc.referrals.pickList.queryOptions({ enabled, staleTime: 60_000 }));
}

export function useJobReferral(jobId: number | null) {
  return useQuery(orpc.referrals.forJob.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: !!jobId, staleTime: 15_000 }));
}

export function useSetJobReferral() {
  const onSuccess = useRefresh();
  return useMutation(orpc.referrals.setForJob.mutationOptions({ onSuccess }));
}

export function useReferrersOwed() {
  return useQuery(orpc.referrals.owed.queryOptions({ staleTime: 15_000 }));
}

export function useAttachReferralInvoice() {
  const onSuccess = useRefresh();
  return useMutation(orpc.referrals.attachInvoice.mutationOptions({ onSuccess }));
}

export function useMarkReferralPaid() {
  const onSuccess = useRefresh();
  return useMutation(orpc.referrals.markPaid.mutationOptions({ onSuccess }));
}

export function useUnmarkReferralPaid() {
  const onSuccess = useRefresh();
  return useMutation(orpc.referrals.unmarkPaid.mutationOptions({ onSuccess }));
}

export function useDecideReferral() {
  const onSuccess = useRefresh();
  return useMutation(orpc.referrals.decide.mutationOptions({ onSuccess }));
}

export function useReferralReport(range: { from: string | null; to: string | null }, enabled = true) {
  return useQuery(orpc.referrals.report.queryOptions({ input: { from: range.from, to: range.to }, enabled, staleTime: 30_000 }));
}
