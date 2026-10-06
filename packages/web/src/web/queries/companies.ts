import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useCompanies(input: { search?: string } = {}) {
  return useQuery(orpc.companies.list.queryOptions({ input, staleTime: 30_000 }));
}

export function useCompany(id: number | null) {
  return useQuery(
    orpc.companies.get.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 15_000 }),
  );
}

/**
 * The people filed under one company, narrowed to roles. Used by the
 * supervisor picker on a job, which only wants people who could have sent it.
 */
export function useCompanyPeople(companyId: number | null, roles?: string[]) {
  return useQuery(
    orpc.companies.people.queryOptions({
      input: { companyId: companyId ?? 0, roles },
      enabled: companyId !== null,
      staleTime: 15_000,
    }),
  );
}

function useCompanyMutation(name: "create" | "update") {
  const queryClient = useQueryClient();
  return orpc.companies[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.companies.key() });
      // The card deposit % feeds payment terms and the forecast.
      if (name === "update") {
        queryClient.invalidateQueries({ queryKey: orpc.finance.key() });
        queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() });
      }
    },
  });
}

export function useCreateCompany() {
  return useMutation(useCompanyMutation("create"));
}
export function useUpdateCompany() {
  return useMutation(useCompanyMutation("update"));
}

/* --------------------------------- sites --------------------------------- */

export function useSites(input: { search?: string; contactId?: number } = {}) {
  return useQuery(orpc.sites.list.queryOptions({ input, staleTime: 30_000 }));
}

function useSiteMutation(name: "create" | "update") {
  const queryClient = useQueryClient();
  return orpc.sites[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.sites.key() });
      queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    },
  });
}

export function useCreateSite() {
  return useMutation(useSiteMutation("create"));
}
export function useUpdateSite() {
  return useMutation(useSiteMutation("update"));
}
