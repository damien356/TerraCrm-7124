import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Conversations. One thread per job, read as one story, sent down separate
 * channels. The audience decides where a message goes, so an internal note has
 * no send path at all and cannot leave the office by accident.
 */

/** The thread on a job. Opens it, or adopts the quote's thread, on first look. */
export function useJobConversation(jobId: number | null) {
  return useQuery(
    orpc.conversations.forJob.queryOptions({
      input: { jobId: jobId ?? 0 },
      enabled: jobId != null,
      staleTime: 5_000,
      // A thread moves while it is open: replies land, sends confirm.
      refetchInterval: 20_000,
    }),
  );
}

/** The thread on a quote, before it becomes a job. */
export function useQuoteConversation(quoteId: number | null) {
  return useQuery(
    orpc.conversations.forQuote.queryOptions({
      input: { quoteId: quoteId ?? 0 },
      enabled: quoteId != null,
      staleTime: 5_000,
      refetchInterval: 20_000,
    }),
  );
}

/** Who can be written to on this job: customers by channel, and the crew on it. */
export function useRecipients(jobId: number | null) {
  return useQuery(
    orpc.conversations.recipients.queryOptions({
      input: { jobId: jobId ?? 0 },
      enabled: jobId != null,
      staleTime: 30_000,
    }),
  );
}

/** What a text will cost, asked before it goes. */
export function useSmsCost(body: string, enabled: boolean) {
  return useQuery(
    orpc.conversations.smsCost.queryOptions({
      input: { body },
      enabled: enabled && body.trim().length > 0,
      staleTime: 60_000,
    }),
  );
}

/**
 * THE INBOX — every thread in the business, one list, newest first.
 * Filed by who is on the other side, not by where it started.
 */
export function useInbox(input: {
  lane: "all" | "unread" | "customers" | "installers" | "suppliers" | "internal";
  kind: "all" | "jobs" | "quotes" | "clients" | "unmatched";
  search?: string;
  companyId?: number;
  staffProfileId?: number;
  jobStatus?: string;
  from?: string;
  to?: string;
}) {
  return useQuery(
    orpc.conversations.inbox.queryOptions({
      input: { ...input, limit: 60 },
      staleTime: 5_000,
      // The inbox is left open on a second screen, so it keeps itself honest.
      refetchInterval: 30_000,
    }),
  );
}

/** The numbers on the filter chips. */
export function useInboxCounts() {
  return useQuery(
    orpc.conversations.inboxCounts.queryOptions({ staleTime: 10_000, refetchInterval: 30_000 }),
  );
}

/** Every thread a contact appears on, newest first. */
export function useContactConversations(contactId: number | null) {
  return useQuery(
    orpc.conversations.forContact.queryOptions({
      input: { contactId: contactId ?? 0 },
      enabled: contactId != null,
      staleTime: 10_000,
    }),
  );
}

function useConversationMutation(name: "send" | "pin" | "unpin" | "markRead") {
  const queryClient = useQueryClient();
  return orpc.conversations[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });
    },
  });
}

export function useSendMessage() {
  return useMutation(useConversationMutation("send"));
}

export function usePinMessage() {
  return useMutation(useConversationMutation("pin"));
}

export function useUnpinMessage() {
  return useMutation(useConversationMutation("unpin"));
}

export function useMarkRead() {
  return useMutation(useConversationMutation("markRead"));
}
