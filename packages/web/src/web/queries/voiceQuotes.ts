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

export function useProcessVoiceQuote() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.voiceQuotes.process.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.voiceQuotes.key() });
        queryClient.invalidateQueries({ queryKey: orpc.quotes.key() });
      },
    }),
  );
}

/** Straight to storage from the browser, same pattern as job media uploads. */
export async function uploadVoiceRecording(blob: Blob, filename: string, contentType: string) {
  const { url, key } = await client.voiceQuotes.presign({ filename, contentType });
  const res = await fetch(url, { method: "PUT", body: blob, headers: { "Content-Type": contentType } });
  if (!res.ok) throw new Error("That recording didn't upload, try again.");
  return key;
}
