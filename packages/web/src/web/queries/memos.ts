import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";
import { uploadVoiceRecording } from "./voiceQuotes";

/** Every voice recording, memo or quote. The Voice drafts page. */
export function useVoiceDrafts(limit = 60) {
  return useQuery(
    orpc.memos.list.queryOptions({
      input: { limit },
      staleTime: 5_000,
      // Keep ticking while anything is still being worked on.
      refetchInterval: (q) =>
        (q.state.data ?? []).some((r) => r.status === "transcribing" || r.status === "routing") ? 3000 : false,
    }),
  );
}

/** One memo, polled every two seconds until it settles. */
export function useVoiceMemo(id: number | null) {
  return useQuery(
    orpc.memos.get.queryOptions({
      input: { id: id ?? 0 },
      enabled: id !== null,
      staleTime: 2_000,
      refetchInterval: (q) => {
        const s = q.state.data?.status;
        return s === "ready" || s === "failed" ? false : 2000;
      },
    }),
  );
}

export function useCardLabel(jobId: number | null, contactId: number | null) {
  return useQuery(
    orpc.memos.cardLabel.queryOptions({
      input: { jobId, contactId },
      enabled: Boolean(jobId || contactId),
      staleTime: 60_000,
    }),
  );
}

/**
 * Upload the recording, then hand it to the router. Answers with the memo id
 * straight away; the result is polled with `useVoiceMemo`, so the published
 * server's 10 second idle cut-off never bites.
 */
export async function startMemo(input: {
  blob: Blob;
  seconds: number;
  jobId: number | null;
  contactId: number | null;
}) {
  const ext = input.blob.type.includes("webm") ? "webm" : "m4a";
  const key = await uploadVoiceRecording(input.blob, `memo.${ext}`, input.blob.type);
  return client.memos.start({
    audioKey: key,
    durationSeconds: input.seconds,
    jobId: input.jobId,
    contactId: input.contactId,
  });
}

/** A memo action can touch nearly anything, so a settled one refreshes the lot. */
function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    for (const key of [
      orpc.memos.key(),
      orpc.officeTasks.key(),
      orpc.jobs.key(),
      orpc.contacts.key(),
      orpc.conversations.key(),
      orpc.quotes.key(),
      orpc.tasks.key(),
      orpc.voiceQuotes.key(),
      orpc.dashboard.key(),
    ]) {
      qc.invalidateQueries({ queryKey: key });
    }
  };
}

export function useStartMemo() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: startMemo, onSettled: invalidate });
}

export function useUpdateDraft() {
  const invalidate = useInvalidateAll();
  return useMutation(orpc.memos.updateDraft.mutationOptions({ onSettled: invalidate }));
}
export function useSendDraft() {
  const invalidate = useInvalidateAll();
  return useMutation(orpc.memos.sendDraft.mutationOptions({ onSettled: invalidate }));
}
export function useDismissAction() {
  const invalidate = useInvalidateAll();
  return useMutation(orpc.memos.dismiss.mutationOptions({ onSettled: invalidate }));
}
export function useMarkBooked() {
  const invalidate = useInvalidateAll();
  return useMutation(orpc.memos.markBooked.mutationOptions({ onSettled: invalidate }));
}
export function useConfirmStatus() {
  const invalidate = useInvalidateAll();
  return useMutation(orpc.memos.confirmStatus.mutationOptions({ onSettled: invalidate }));
}
export function useResolveClient() {
  const invalidate = useInvalidateAll();
  return useMutation(orpc.memos.resolveClient.mutationOptions({ onSettled: invalidate }));
}

/** The settled client's jobs, for Change job on an action. Only fetched once the list is opened. */
export function useMemoJobChoices(id: number, enabled: boolean) {
  return useQuery(orpc.memos.jobChoices.queryOptions({ input: { id }, enabled, staleTime: 30_000 }));
}
export function useSetActionJob() {
  const invalidate = useInvalidateAll();
  return useMutation(orpc.memos.setActionJob.mutationOptions({ onSettled: invalidate }));
}
/** Fix what I heard: run the memo again from corrected words. */
export function useRerunMemo() {
  const invalidate = useInvalidateAll();
  return useMutation(orpc.memos.rerun.mutationOptions({ onSettled: invalidate }));
}

/* ------------------------------ office tasks ------------------------------ */

export function useOfficeTasks() {
  return useQuery(
    orpc.officeTasks.open.queryOptions({
      staleTime: 15_000,
      // A reminder coming due should show without a reload.
      refetchInterval: 60_000,
    }),
  );
}

export function useCompleteOfficeTask() {
  const qc = useQueryClient();
  return useMutation(
    orpc.officeTasks.complete.mutationOptions({
      onSettled: () => qc.invalidateQueries({ queryKey: orpc.officeTasks.key() }),
    }),
  );
}

export function useSnoozeOfficeTask() {
  const qc = useQueryClient();
  return useMutation(
    orpc.officeTasks.snooze.mutationOptions({
      onSettled: () => qc.invalidateQueries({ queryKey: orpc.officeTasks.key() }),
    }),
  );
}

/** The board's booking, typed on its own so the memo card gets the real input shape. */
/** A memo booking on a job with no dispatch yet: add one, then book it. */
export function useAddDispatchFromMemo() {
  const invalidate = useInvalidateAll();
  return useMutation(orpc.tasks.create.mutationOptions({ onSettled: invalidate }));
}
export function useBookFromMemo() {
  const invalidate = useInvalidateAll();
  return useMutation(orpc.tasks.book.mutationOptions({ onSettled: invalidate }));
}
