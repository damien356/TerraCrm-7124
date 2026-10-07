import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** The SWMS library editor: templates, task blocks, site checks, SDS products, the log. */
export function useSwmsLibrary() {
  return useQuery(orpc.swmsLib.overview.queryOptions({ staleTime: 10_000 }));
}

export function useSwmsChanges(input: { entityType?: string; entityId?: number; limit?: number } = {}) {
  return useQuery(orpc.swmsLib.changes.queryOptions({ input: { limit: 200, ...input }, staleTime: 10_000 }));
}

export function useSwmsVersions(id: number | null) {
  return useQuery(orpc.swmsLib.versions.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null }));
}

export function useSwmsPreview(id: number | null) {
  return useQuery(orpc.swmsLib.preview.queryOptions({ input: { id: id ?? 0, pdf: false }, enabled: id !== null, staleTime: 0 }));
}

export function useSwmsJobTemplates(jobId: number) {
  return useQuery(orpc.swmsLib.jobTemplates.queryOptions({ input: { jobId }, staleTime: 10_000 }));
}

function useDone() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: orpc.swmsLib.key() });
    void qc.invalidateQueries({ queryKey: orpc.swms.key() });
  };
}

export function useSaveBlock() {
  const done = useDone();
  return useMutation(orpc.swmsLib.blockSave.mutationOptions({ onSuccess: done }));
}
export function useDuplicateBlock() {
  const done = useDone();
  return useMutation(orpc.swmsLib.blockDuplicate.mutationOptions({ onSuccess: done }));
}
export function useArchiveBlock() {
  const done = useDone();
  return useMutation(orpc.swmsLib.blockArchive.mutationOptions({ onSuccess: done }));
}
export function useSaveTemplate() {
  const done = useDone();
  return useMutation(orpc.swmsLib.templateSave.mutationOptions({ onSuccess: done }));
}
export function useDuplicateTemplate() {
  const done = useDone();
  return useMutation(orpc.swmsLib.templateDuplicate.mutationOptions({ onSuccess: done }));
}
export function useArchiveTemplate() {
  const done = useDone();
  return useMutation(orpc.swmsLib.templateArchive.mutationOptions({ onSuccess: done }));
}
export function usePublishTemplate() {
  const done = useDone();
  return useMutation(orpc.swmsLib.publish.mutationOptions({ onSuccess: done }));
}
export function usePreviewPdf() {
  return useMutation(orpc.swmsLib.preview.mutationOptions());
}
export function useSaveSiteCheck() {
  const done = useDone();
  return useMutation(orpc.swmsLib.siteCheckSave.mutationOptions({ onSuccess: done }));
}
export function useArchiveSiteCheck() {
  const done = useDone();
  return useMutation(orpc.swmsLib.siteCheckArchive.mutationOptions({ onSuccess: done }));
}
export function useSaveSdsProduct() {
  const done = useDone();
  return useMutation(orpc.swmsLib.sdsProductSave.mutationOptions({ onSuccess: done }));
}
export function useArchiveSdsProduct() {
  const done = useDone();
  return useMutation(orpc.swmsLib.sdsProductArchive.mutationOptions({ onSuccess: done }));
}
export function usePinJobTemplate() {
  const done = useDone();
  return useMutation(orpc.swmsLib.jobPin.mutationOptions({ onSuccess: done }));
}
