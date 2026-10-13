import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* Lead sources, landing pages, ad spend and the leads report (notes 18.38). */

export type LeadRange = { from?: string; to?: string; clientType?: string };

/** The active list for the New job and quote pickers. */
export function useLeadSources() {
  return useQuery(orpc.leads.sources.queryOptions({ staleTime: 5 * 60_000 }));
}

export function useLeadSettings() {
  return useQuery(orpc.leads.settings.queryOptions());
}

export function useBlockedLeads(enabled = true) {
  return useQuery(orpc.leads.blocked.queryOptions({ input: { limit: 100 }, enabled }));
}

export function useAdSpend(year: number) {
  return useQuery(orpc.leads.spend.queryOptions({ input: { year } }));
}

export function useLeadReport(range: LeadRange) {
  return useQuery(orpc.leads.report.queryOptions({ input: clean(range) }));
}

export function useLeadDrill(range: LeadRange & { source: string | null; month?: string }) {
  const { source, month, ...rest } = range;
  return useQuery(
    orpc.leads.drill.queryOptions({
      input: { ...clean(rest), source: source ?? "", ...(month ? { month } : {}) },
      enabled: !!source,
    }),
  );
}

export function useTopSources(enabled: boolean) {
  return useQuery(orpc.leads.topThisMonth.queryOptions({ enabled, staleTime: 5 * 60_000 }));
}

function clean(r: LeadRange) {
  return {
    ...(r.from ? { from: r.from } : {}),
    ...(r.to ? { to: r.to } : {}),
    ...(r.clientType ? { clientType: r.clientType } : {}),
  };
}

function useInvalidateLeads() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: orpc.leads.key() });
    qc.invalidateQueries({ queryKey: orpc.jobs.key() });
  };
}

export function useSaveLeadSource() {
  const invalidate = useInvalidateLeads();
  return useMutation(orpc.leads.saveSource.mutationOptions({ onSuccess: invalidate }));
}

export function useSaveLandingPage() {
  const invalidate = useInvalidateLeads();
  return useMutation(orpc.leads.savePage.mutationOptions({ onSuccess: invalidate }));
}

export function useReleaseLead() {
  const invalidate = useInvalidateLeads();
  return useMutation(orpc.leads.release.mutationOptions({ onSuccess: invalidate }));
}

export function useSaveAdSpend() {
  const invalidate = useInvalidateLeads();
  return useMutation(orpc.leads.saveSpend.mutationOptions({ onSuccess: invalidate }));
}

export function useSaveAutoReply() {
  const invalidate = useInvalidateLeads();
  return useMutation(orpc.leads.saveAutoReply.mutationOptions({ onSuccess: invalidate }));
}
