import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "@/lib/api";

/**
 * My hours & invoices (Damien, 13 Nov 2026). All on `orpc.hourlyInvoices.*`,
 * installer scoped on the server: only his own jobs, time, invoices and pay.
 * Nothing here talks to Xero.
 */

export type Period = { kind: "today" } | { kind: "week" } | { kind: "dates"; from: string; to: string };

export function useInvoicingReady() {
  return useQuery(orpc.hourlyInvoices.ready.queryOptions({ retry: false, staleTime: 5 * 60_000 }));
}

export function useMyHourlyJobs() {
  return useQuery(orpc.hourlyInvoices.myJobs.queryOptions({ retry: false, staleTime: 30_000 }));
}

export function useMyInvoiceSummary() {
  return useQuery(orpc.hourlyInvoices.summary.queryOptions({ retry: false, staleTime: 30_000 }));
}

export function useInvoicePreview(period: Period | null, sessionIds?: number[]) {
  return useQuery(
    orpc.hourlyInvoices.preview.queryOptions({
      input: { period: period ?? { kind: "today" }, sessionIds: sessionIds?.length ? sessionIds : undefined },
      enabled: period != null,
      retry: false,
    }),
  );
}

export function useMyPeriodInvoices() {
  return useQuery(orpc.hourlyInvoices.invoices.queryOptions({ retry: false, staleTime: 30_000 }));
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: orpc.hourlyInvoices.key() });
    void qc.invalidateQueries({ queryKey: orpc.hourly.key() });
    void qc.invalidateQueries({ queryKey: orpc.installerInvoices.key() });
  };
}

/** Issue & send to Terra. The caller makes requestKey once per tap and reuses it on a retry. */
export function useIssueInvoice() {
  const invalidate = useInvalidate();
  return useMutation(orpc.hourlyInvoices.issue.mutationOptions({ onSettled: invalidate }));
}

export function usePeriodInvoicePdf() {
  return useMutation(orpc.hourlyInvoices.downloadUrl.mutationOptions());
}

export function useResendInvoice() {
  const invalidate = useInvalidate();
  return useMutation(orpc.hourlyInvoices.resend.mutationOptions({ onSuccess: invalidate }));
}

export function newRequestKey() {
  return `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
