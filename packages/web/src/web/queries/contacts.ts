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

/* One options object per hook: a helper indexed by a name union gave every hook a union input type. */
function useContactRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.contacts.key() });
    queryClient.invalidateQueries({ queryKey: orpc.companies.key() });
    queryClient.invalidateQueries({ queryKey: orpc.intel.key() });
    queryClient.invalidateQueries({ queryKey: orpc.finance.key() });
  };
}

export function useCreateContact() {
  const onSuccess = useContactRefresh();
  return useMutation(orpc.contacts.create.mutationOptions({ onSuccess }));
}
export function useUpdateContact() {
  const onSuccess = useContactRefresh();
  return useMutation(orpc.contacts.update.mutationOptions({ onSuccess }));
}
export function useLinkCompany() {
  const onSuccess = useContactRefresh();
  return useMutation(orpc.contacts.linkCompany.mutationOptions({ onSuccess }));
}
export function useUnlinkCompany() {
  const onSuccess = useContactRefresh();
  return useMutation(orpc.contacts.unlinkCompany.mutationOptions({ onSuccess }));
}

export function useMoveSupervisorCompany() {
  const onSuccess = useContactRefresh();
  return useMutation(orpc.contacts.moveCompany.mutationOptions({ onSuccess }));
}

/**
 * Clients by name, mobile, email or suburb, searched on the server. The
 * pickers use this rather than loading the list, which is too long to load
 * whole. Idle until something is typed. Keeps the last answer on screen while
 * the next keystroke's answer is on its way.
 */
export function useContactSearch(search: string) {
  const q = search.trim();
  return useQuery(
    orpc.contacts.list.queryOptions({
      input: { search: q, limit: 30 },
      enabled: q.length > 0,
      staleTime: 20_000,
      placeholderData: (prev) => prev,
    }),
  );
}
