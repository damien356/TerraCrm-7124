import { useMutation, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "@/lib/api";

/**
 * Voice quotes from the phone. Same three steps as the web page: get a
 * presigned slot, put the recording straight into storage, then ask the
 * server to transcribe, price and draft the quote. All three are admin only.
 */
export async function uploadVoiceRecording({
  uri,
  filename,
  contentType,
}: {
  uri: string;
  filename: string;
  contentType: string;
}) {
  const { url, key } = await client.voiceQuotes.presign({ filename, contentType });
  const blob = await (await fetch(uri)).blob();
  const res = await fetch(url, { method: "PUT", body: blob, headers: { "Content-Type": contentType } });
  if (!res.ok) throw new Error("The recording didn't upload. Check your signal and try again.");
  return key;
}

export function useProcessVoiceQuote() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.voiceQuotes.process.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() });
      },
    }),
  );
}
