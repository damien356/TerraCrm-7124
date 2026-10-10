import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** People on a quote, the "already exists" check, duplicate cards, company types and referrers. */

export function useQuotePeople(quoteId: number | null) {
  return useQuery(orpc.people.quoteList.queryOptions({ input: { quoteId: quoteId ?? 0 }, enabled: !!quoteId }));
}

/* Each mutation gets its own options object: a shared union-typed helper loses the input types. */
function useRefresh(alsoPeopleCards = false) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: orpc.people.key() });
    qc.invalidateQueries({ queryKey: orpc.quotes.key() });
    qc.invalidateQueries({ queryKey: orpc.jobs.key() });
    qc.invalidateQueries({ queryKey: orpc.tasks.key() });
    if (alsoPeopleCards) qc.invalidateQueries({ queryKey: orpc.contacts.key() });
  };
}

export function useQuotePersonAdd() {
  const onSuccess = useRefresh();
  return useMutation(orpc.people.quoteAdd.mutationOptions({ onSuccess }));
}
export function useQuotePersonUpdate() {
  const onSuccess = useRefresh();
  return useMutation(orpc.people.quoteUpdate.mutationOptions({ onSuccess }));
}
export function useQuotePersonRemove() {
  const onSuccess = useRefresh();
  return useMutation(orpc.people.quoteRemove.mutationOptions({ onSuccess }));
}
export function useMergeContacts() {
  const onSuccess = useRefresh(true);
  return useMutation(orpc.people.merge.mutationOptions({ onSuccess }));
}

/* Job people, typed one by one (queries/jobs.ts shares one helper for the rest). */
export function useJobPersonAdd() {
  const onSuccess = useRefresh();
  return useMutation(orpc.jobs.addContact.mutationOptions({ onSuccess }));
}
export function useJobPersonUpdate() {
  const onSuccess = useRefresh();
  return useMutation(orpc.jobs.updateContact.mutationOptions({ onSuccess }));
}
export function useJobPersonRemove() {
  const onSuccess = useRefresh();
  return useMutation(orpc.jobs.removeContact.mutationOptions({ onSuccess }));
}

export interface MatchInput {
  mobile?: string | null;
  phone?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  excludeId?: number | null;
}

/** Cards that already have this mobile, email or name. Asked while a new card is typed. */
export function useContactMatches(input: MatchInput, enabled = true) {
  const digits = (input.mobile ?? "").replace(/\D/g, "") + (input.phone ?? "").replace(/\D/g, "");
  const has = digits.length >= 8 || (input.email ?? "").includes("@") || ((input.firstName ?? "").trim() && (input.lastName ?? "").trim());
  return useQuery(
    orpc.people.matches.queryOptions({ input, enabled: enabled && !!has, staleTime: 30_000, placeholderData: (prev) => prev }),
  );
}

export function useDuplicates(enabled = true) {
  return useQuery(orpc.people.duplicates.queryOptions({ enabled }));
}

export function useCompanyTypes() {
  return useQuery(orpc.people.companyTypes.queryOptions());
}

export function useReferrers(range: { from?: string | null; to?: string | null }) {
  return useQuery(orpc.people.referrers.queryOptions({ input: range, staleTime: 30_000 }));
}

/** Companies that already have this name, phone or email. Asked while a new company is typed. */
export function useCompanyMatches(input: { name?: string | null; phone?: string | null; email?: string | null }, enabled = true) {
  const has =
    (input.name ?? "").trim().length >= 3 ||
    (input.phone ?? "").replace(/\D/g, "").length >= 8 ||
    (input.email ?? "").includes("@");
  return useQuery(
    orpc.people.companyMatches.queryOptions({ input, enabled: enabled && has, staleTime: 30_000, placeholderData: (prev) => prev }),
  );
}
