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

type ProcessInput = Parameters<typeof client.voiceQuotes.start>[0];

/**
 * Start the job on the server, then poll until the quote is made. A single
 * long request ran past the server's 10 second idle cut-off and failed on the
 * phone even though the quote had been created.
 */
async function processVoiceQuote(input: ProcessInput) {
  const { captureId } = await client.voiceQuotes.start(input);
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await client.voiceQuotes.status({ id: captureId });
    if (s.status === "done" && s.result) return s.result;
    if (s.status === "failed") throw new Error(s.errorMessage ?? "That recording could not be turned into a quote.");
  }
  throw new Error("Still working on it. Check Voice quotes on the website in a minute.");
}

export function useProcessVoiceQuote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: processVoiceQuote,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() });
    },
  });
}
