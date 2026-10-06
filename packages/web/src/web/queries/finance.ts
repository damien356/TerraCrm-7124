import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Finance hooks. Every mutation here can move the forecast, so they all
 * invalidate the finance keys rather than trying to be clever about which
 * screen cares.
 */

export type ForecastWindow = "12w" | "6m" | "12m";

export function useForecast(input: { window: ForecastWindow; includePipeline: boolean }) {
  return useQuery(orpc.finance.forecast.queryOptions({ input, staleTime: 30_000 }));
}

export function useOpeningBalance() {
  return useQuery(orpc.finance.openingBalanceGet.queryOptions({ input: {}, staleTime: 60_000 }));
}

export function useJobBudget(jobId: number | null) {
  return useQuery(
    orpc.finance.jobBudget.queryOptions({
      input: { jobId: jobId ?? 0 },
      enabled: jobId !== null,
      staleTime: 15_000,
    }),
  );
}

export function useExpenses(days = 60) {
  return useQuery(orpc.finance.expenses.queryOptions({ input: { days }, staleTime: 30_000 }));
}

export function useReceipts(days = 60) {
  return useQuery(orpc.finance.receipts.queryOptions({ input: { days }, staleTime: 30_000 }));
}

export function useInvoiceList(input: { status: "all" | "unpaid" | "overdue" | "paid"; limit?: number }) {
  return useQuery(
    orpc.finance.invoiceList.queryOptions({
      input: { status: input.status, limit: input.limit ?? 200 },
      staleTime: 30_000,
    }),
  );
}

export function useTermsList() {
  return useQuery(orpc.finance.termsList.queryOptions({ input: {}, staleTime: 60_000 }));
}

export function useTerms(input: { companyId?: number; jobId?: number }) {
  return useQuery(
    orpc.finance.termsGet.queryOptions({
      input,
      enabled: input.companyId !== undefined || input.jobId !== undefined,
      staleTime: 30_000,
    }),
  );
}

/** Anything that changes money invalidates the whole finance tree. */
function useFinanceMutation(name: "openingBalanceSet" | "termsSet" | "termsClear" | "costSave" | "costDelete" | "rebuild" | "milestoneSet") {
  const queryClient = useQueryClient();
  return orpc.finance[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.finance.key() });
      queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() });
      // Terms carry the company's deposit %, the same setting as the card.
      if (name === "termsSet") queryClient.invalidateQueries({ queryKey: orpc.companies.key() });
    },
  });
}

export function useSetOpeningBalance() {
  return useMutation(useFinanceMutation("openingBalanceSet"));
}
export function useSetTerms() {
  return useMutation(useFinanceMutation("termsSet"));
}
export function useClearTerms() {
  return useMutation(useFinanceMutation("termsClear"));
}
export function useSaveCost() {
  return useMutation(useFinanceMutation("costSave"));
}
export function useDeleteCost() {
  return useMutation(useFinanceMutation("costDelete"));
}
export function useRebuildForecast() {
  return useMutation(useFinanceMutation("rebuild"));
}
/** Progress claim stages, which only exist under a saved terms row. */
export function useSetMilestones() {
  return useMutation(useFinanceMutation("milestoneSet"));
}
