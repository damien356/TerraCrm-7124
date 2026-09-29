import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Subcontractor invoices, from the office side. These are invoices the
 * installers issue to Terra for their own pay, so nothing here creates or
 * edits an amount. The office only moves one along its payment lifecycle,
 * and decides the extras an installer asked for.
 */

export type InvoiceStatus = "submitted" | "approved" | "scheduled_for_payment" | "paid";

export function useSubcontractorInvoices(filters: {
  installerId?: number;
  jobId?: number;
  status?: InvoiceStatus;
  from?: string;
  to?: string;
}) {
  return useQuery(
    orpc.installerInvoices.adminList.queryOptions({ input: filters, staleTime: 15_000 }),
  );
}

export function useVariationRequests(status?: "pending" | "approved" | "rejected") {
  return useQuery(
    orpc.installerInvoices.adminListVariations.queryOptions({
      input: { status },
      staleTime: 15_000,
    }),
  );
}

function useInvoiceMutation(name: "adminSetStatus" | "adminDecideVariation") {
  const queryClient = useQueryClient();
  return orpc.installerInvoices[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.installerInvoices.key() });
    },
  });
}

/** Approved, then scheduled for payment, then paid. */
export function useSetInvoiceStatus() {
  return useMutation(useInvoiceMutation("adminSetStatus"));
}

/** Approve or knock back an extra. Only an approved one can reach an invoice. */
export function useDecideVariation() {
  return useMutation(useInvoiceMutation("adminDecideVariation"));
}

/** A signed link to the PDF the installer submitted. */
export function useInvoicePdfUrl() {
  return useMutation(orpc.installerInvoices.adminDownloadUrl.mutationOptions());
}
