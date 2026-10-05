import { useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Client, company and supervisor intelligence. Read-only: these are rollups
 * over jobs, invoices and costs, so nothing here writes.
 */

export type IntelSort = "revenue" | "gp" | "jobs" | "recent";
/** The customer lists add name order, since they double as the address book. */
export type ListSort = IntelSort | "name";

export function useClientIntel(input: { search?: string; sort?: ListSort; limit?: number } = {}) {
  return useQuery(
    orpc.intel.clients.queryOptions({
      input: { search: input.search ?? "", sort: input.sort ?? "revenue", limit: input.limit ?? 100 },
      staleTime: 60_000,
    }),
  );
}

export function useClient(id: number | null) {
  return useQuery(
    orpc.intel.client.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 30_000 }),
  );
}

export function useCompanyIntel(
  input: { search?: string; sort?: ListSort | "outstanding"; limit?: number } = {},
) {
  return useQuery(
    orpc.intel.companies.queryOptions({
      input: { search: input.search ?? "", sort: input.sort ?? "revenue", limit: input.limit ?? 100 },
      staleTime: 60_000,
    }),
  );
}

export function useCompanyIntelDetail(id: number | null) {
  return useQuery(
    orpc.intel.company.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 30_000 }),
  );
}

export type SupRange = "12m" | "year" | "all";

export function useSupervisors(input: { search?: string; sort?: IntelSort; range?: SupRange } = {}) {
  return useQuery(
    orpc.intel.supervisors.queryOptions({
      input: { search: input.search ?? "", sort: input.sort ?? "revenue", range: input.range ?? "12m" },
      staleTime: 60_000,
    }),
  );
}

/** Supervisors who have sent work before but nothing for a while. Used by the Dashboard. */
export function useGoneQuiet() {
  return useQuery(orpc.intel.goneQuiet.queryOptions({ staleTime: 120_000 }));
}

export function useSupervisor(id: number | null) {
  return useQuery(
    orpc.intel.supervisor.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 30_000 }),
  );
}

export type ProfitabilityScope = "companies" | "clients" | "supervisors";

export function useProfitability(input: { scope: ProfitabilityScope; limit?: number }) {
  return useQuery(
    orpc.intel.profitability.queryOptions({
      input: { scope: input.scope, limit: input.limit ?? 50 },
      staleTime: 60_000,
    }),
  );
}

/** How many jobs still have nobody recorded as the supervisor. */
export function useSupervisorAttribution(enabled = true) {
  return useQuery(orpc.intel.supervisorAttribution.queryOptions({ enabled, staleTime: 60_000 }));
}
