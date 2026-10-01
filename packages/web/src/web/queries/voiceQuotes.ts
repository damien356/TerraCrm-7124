import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

export function useVoiceCaptures(limit = 50) {
  return useQuery(orpc.voiceQuotes.list.queryOptions({ input: { limit }, staleTime: 10_000 }));
}

export function useVoiceCapture(id: number | null) {
  return useQuery(
    orpc.voiceQuotes.get.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 5_000 }),
  );
}

type ProcessInput = Parameters<typeof client.voiceQuotes.start>[0];

/**
 * Kick the recording off on the server, then poll until the quote is made.
 * One long request used to hit the server's 10 second idle cut-off and show
 * "Load failed" even when the quote had been created fine.
 */
export async function processVoiceQuote(input: ProcessInput) {
  const { captureId } = await client.voiceQuotes.start(input);
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await client.voiceQuotes.status({ id: captureId });
    if (s.status === "done" && s.result) return s.result;
    if (s.status === "failed") throw new Error(s.errorMessage ?? "That recording could not be processed.");
  }
  throw new Error("Still working on it. Check Recent captures in a minute.");
}

export function useProcessVoiceQuote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: processVoiceQuote,
    // Settled, not success: a failed run still leaves a capture row behind,
    // and the office should see it in Recent captures straight away.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: orpc.voiceQuotes.key() });
      queryClient.invalidateQueries({ queryKey: orpc.quotes.key() });
    },
  });
}

/** Straight to storage from the browser, same pattern as job media uploads. */
export async function uploadVoiceRecording(blob: Blob, filename: string, contentType: string) {
  const { url, key } = await client.voiceQuotes.presign({ filename, contentType });
  const res = await fetch(url, { method: "PUT", body: blob, headers: { "Content-Type": contentType } });
  if (!res.ok) throw new Error("That recording didn't upload, try again.");
  return key;
}
