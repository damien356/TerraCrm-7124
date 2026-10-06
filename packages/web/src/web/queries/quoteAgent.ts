import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

/**
 * The quote assistant in the builder. A turn can take 20 seconds, so `start`
 * answers at once and the history is polled while a turn is running. That
 * also picks the answer up again after a page reload mid-turn.
 */
export function useQuoteAgentHistory(quoteId: number) {
  return useQuery(
    orpc.quoteAgent.history.queryOptions({
      input: { quoteId },
      staleTime: 5_000,
      refetchInterval: (query) => (query.state.data?.runningFor ? 2_000 : false),
    }),
  );
}

/** The pre-send check on its own. Run on demand, never on load. */
export function useQuoteCheck(quoteId: number, enabled: boolean) {
  return useQuery(orpc.quoteAgent.check.queryOptions({ input: { quoteId }, enabled, staleTime: 0 }));
}

type AskInput = Parameters<typeof client.quoteAgent.start>[0];

/** Send a question, then wait for the answer. Resolves with the assistant's reply. */
export async function askQuoteAgent(input: AskInput, onStarted?: () => void) {
  const { userMessageId } = await client.quoteAgent.start(input);
  onStarted?.();
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await client.quoteAgent.status({ quoteId: input.quoteId, userMessageId });
    if (s.status === "done" && s.answer) return s.answer;
    if (s.status === "stopped") throw new Error("That answer stopped part way. Ask again.");
  }
  throw new Error("Still working on it. Check back in a minute.");
}

export function useAskQuoteAgent() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.quoteAgent.key() });
  return useMutation({
    mutationFn: (input: AskInput) => askQuoteAgent(input, refresh),
    onSettled: refresh,
  });
}

export function useApplyQuoteAgent() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.quoteAgent.apply.mutationOptions({
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey: orpc.quotes.key() });
        queryClient.invalidateQueries({ queryKey: orpc.quoteBundles.key() });
        queryClient.invalidateQueries({ queryKey: orpc.quoteAgent.key() });
      },
    }),
  );
}

export function useClearQuoteAgent() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.quoteAgent.clear.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.quoteAgent.key() }),
    }),
  );
}
