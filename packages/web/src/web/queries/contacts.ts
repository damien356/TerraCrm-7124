import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Contacts are people — they exist once, forever. Companies are a wrapper. */
export function useContacts(input: { search?: string; companyId?: number } = {}) {
  return useQuery(orpc.contacts.list.queryOptions({ input, staleTime: 20_000 }));
}

export function useContact(id: number | null) {
  return useQuery(
    orpc.contacts.get.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 10_000 }),
  );
}

function useContactMutation(name: "create" | "update" | "linkCompany" | "unlinkCompany" | "moveCompany") {
  const queryClient = useQueryClient();
  return orpc.contacts[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.contacts.key() });
      queryClient.invalidateQueries({ queryKey: orpc.companies.key() });
      queryClient.invalidateQueries({ queryKey: orpc.intel.key() });
    },
  });
}

export function useCreateContact() {
  return useMutation(useContactMutation("create"));
}
export function useUpdateContact() {
  return useMutation(useContactMutation("update"));
}
export function useLinkCompany() {
  return useMutation(useContactMutation("linkCompany"));
}
export function useUnlinkCompany() {
  return useMutation(useContactMutation("unlinkCompany"));
}

export function useMoveSupervisorCompany() {
  return useMutation(useContactMutation("moveCompany"));
}
