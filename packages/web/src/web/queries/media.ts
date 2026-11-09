import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

export function useJobMedia(jobId: number | null, includeArchived = false) {
  return useQuery(
    orpc.media.list.queryOptions({
      input: { jobId: jobId ?? 0, includeArchived },
      enabled: jobId !== null,
      staleTime: 10_000,
    }),
  );
}

export function useJobAreas(jobId: number | null) {
  return useQuery(
    orpc.areas.list.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: jobId !== null, staleTime: 30_000 }),
  );
}

function useInvalidateJobFile() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.media.key() });
    queryClient.invalidateQueries({ queryKey: orpc.areas.key() });
  };
}

export function useAttachMedia() {
  const invalidate = useInvalidateJobFile();
  return useMutation(orpc.media.attach.mutationOptions({ onSuccess: invalidate }));
}

export function useArchiveMedia() {
  const invalidate = useInvalidateJobFile();
  return useMutation(orpc.media.archive.mutationOptions({ onSuccess: invalidate }));
}

export function useMoveMedia() {
  const invalidate = useInvalidateJobFile();
  return useMutation(orpc.media.move.mutationOptions({ onSuccess: invalidate }));
}

/** "Show to crew": a person checked it. Refused for restricted files. */
export function useApproveForCrew() {
  const invalidate = useInvalidateJobFile();
  return useMutation(orpc.media.approveForCrew.mutationOptions({ onSuccess: invalidate }));
}

/** "Keep office only", and taking a file back off the crew. */
export function useKeepOffice() {
  const invalidate = useInvalidateJobFile();
  return useMutation(orpc.media.keepOffice.mutationOptions({ onSuccess: invalidate }));
}

/** Admin only: restrict a file, or lift a wrong restriction (back to Needs review), with a reason. */
export function useReclassifyMedia() {
  const invalidate = useInvalidateJobFile();
  return useMutation(orpc.media.reclassify.mutationOptions({ onSuccess: invalidate }));
}

/** Site access details a client sent in, waiting for the office. */
export function useAccessProposals(jobId: number | null) {
  return useQuery(orpc.accessNotes.list.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: jobId !== null, staleTime: 10_000 }));
}

function useInvalidateAccess() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.accessNotes.key() });
    queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
  };
}

export function useApproveAccessNote() {
  const invalidate = useInvalidateAccess();
  return useMutation(orpc.accessNotes.approve.mutationOptions({ onSuccess: invalidate }));
}

export function useDismissAccessNote() {
  const invalidate = useInvalidateAccess();
  return useMutation(orpc.accessNotes.dismiss.mutationOptions({ onSuccess: invalidate }));
}

export function useSetMediaCaption() {
  const invalidate = useInvalidateJobFile();
  return useMutation(orpc.media.setCaption.mutationOptions({ onSuccess: invalidate }));
}

export function useCreateArea() {
  const invalidate = useInvalidateJobFile();
  return useMutation(orpc.areas.create.mutationOptions({ onSuccess: invalidate }));
}

export function useUpdateArea() {
  const invalidate = useInvalidateJobFile();
  return useMutation(orpc.areas.update.mutationOptions({ onSuccess: invalidate }));
}

export function useRemoveArea() {
  const invalidate = useInvalidateJobFile();
  return useMutation(orpc.areas.remove.mutationOptions({ onSuccess: invalidate }));
}

/** Straight to storage from the browser — the file never touches the API server. */
export async function uploadToStorage(file: File, jobId: number, bucket: string) {
  const { url, key } = await client.upload.presign({
    jobId,
    bucket,
    filename: file.name,
    contentType: file.type || "application/octet-stream",
  });
  const res = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
  if (!res.ok) throw new Error("That upload didn't go through. Try again.");
  return key;
}
