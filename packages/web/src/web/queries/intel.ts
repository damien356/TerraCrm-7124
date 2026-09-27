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

export function useSupervisors(input: { search?: string; sort?: IntelSort; limit?: number } = {}) {
  return useQuery(
    orpc.intel.supervisors.queryOptions({
      input: { search: input.search ?? "", sort: input.sort ?? "revenue", limit: input.limit ?? 100 },
      staleTime: 60_000,
    }),
  );
}

export function useSupervisor(id: number | null) {
  return useQuery(
    orpc.intel.supervisor.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 30_000 }),
  );
}

export function useProfitability(input: { scope: "companies" | "clients"; limit?: number }) {
  return useQuery(
    orpc.intel.profitability.queryOptions({
      input: { scope: input.scope, limit: input.limit ?? 50 },
      staleTime: 60_000,
    }),
  );
}
