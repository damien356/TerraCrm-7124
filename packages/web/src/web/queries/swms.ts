import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** SWMS panel on a job: on or off, why, and every signed record. */
export function useSwmsJob(jobId: number | null) {
  return useQuery(orpc.swms.job.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: jobId !== null, staleTime: 10_000 }));
}

/** Who is booked on a SWMS job each day, and whether they've signed. */
export function useSwmsBoard(input: { from?: string; to?: string }) {
  return useQuery(orpc.swms.board.queryOptions({ input, staleTime: 15_000, refetchInterval: 60_000 }));
}

export function useSafetyDocs() {
  return useQuery(orpc.swms.docs.queryOptions({ staleTime: 30_000 }));
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: orpc.swms.key() });
    void qc.invalidateQueries({ queryKey: orpc.contacts.key() });
    void qc.invalidateQueries({ queryKey: orpc.companies.key() });
  };
}

export function useSetJobSwms() {
  const done = useInvalidate();
  return useMutation(orpc.swms.setJob.mutationOptions({ onSuccess: done }));
}

export function useSetContactSwms() {
  const done = useInvalidate();
  return useMutation(orpc.swms.setContact.mutationOptions({ onSuccess: done }));
}

export function useSetCompanySwms() {
  const done = useInvalidate();
  return useMutation(orpc.swms.setCompany.mutationOptions({ onSuccess: done }));
}

export function useSdsUploadUrl() {
  return useMutation(orpc.swms.docUploadUrl.mutationOptions());
}

export function useSaveSds() {
  const done = useInvalidate();
  return useMutation(orpc.swms.docSave.mutationOptions({ onSuccess: done }));
}

export function useArchiveSds() {
  const done = useInvalidate();
  return useMutation(orpc.swms.docArchive.mutationOptions({ onSuccess: done }));
}

/** Who the SWMS email goes to. Only loaded when the email box opens. */
export function useSwmsEmailPeople(jobId: number, enabled: boolean) {
  return useQuery(orpc.swms.emailPeople.queryOptions({ input: { jobId }, enabled, staleTime: 0 }));
}

export function useClearSwmsFlag() {
  const done = useInvalidate();
  return useMutation(orpc.swms.clearFlag.mutationOptions({ onSuccess: done }));
}

export function useEmailSwms() {
  const done = useInvalidate();
  return useMutation(orpc.swms.emailRecord.mutationOptions({ onSuccess: done }));
}
