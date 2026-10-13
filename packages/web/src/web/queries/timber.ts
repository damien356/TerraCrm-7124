import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* Timber repairs priced by Marc (notes 18.38). */

export function useTimberSettings(enabled = true) {
  return useQuery(orpc.timber.settings.queryOptions({ enabled }));
}

export function useTimberPreview(marcPrice: number | null) {
  return useQuery(
    orpc.timber.preview.queryOptions({ input: { marcPrice: marcPrice ?? 0 }, enabled: marcPrice != null && marcPrice > 0 }),
  );
}

export function useRepairs(open: boolean) {
  return useQuery(orpc.timber.list.queryOptions({ input: { open } }));
}

export function useRepair(id: number | null) {
  return useQuery(orpc.timber.get.queryOptions({ input: { id: id ?? 0 }, enabled: id != null && id > 0 }));
}

export function useTimberReport(enabled = true) {
  return useQuery(orpc.timber.report.queryOptions({ enabled }));
}

export function useRepairPhotos(token: string) {
  return useQuery(orpc.timber.photos.queryOptions({ input: { token }, retry: false }));
}

function useInvalidateTimber() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: orpc.timber.key() });
    qc.invalidateQueries({ queryKey: orpc.quotes.key() });
    qc.invalidateQueries({ queryKey: orpc.jobs.key() });
  };
}

export function useSaveTimberSettings() {
  const invalidate = useInvalidateTimber();
  return useMutation(orpc.timber.saveSettings.mutationOptions({ onSuccess: invalidate }));
}

export function useApproveRepair() {
  const invalidate = useInvalidateTimber();
  return useMutation(orpc.timber.approve.mutationOptions({ onSuccess: invalidate }));
}

export function useResendRepair() {
  const invalidate = useInvalidateTimber();
  return useMutation(orpc.timber.resend.mutationOptions({ onSuccess: invalidate }));
}

export function useSetRepairPrice() {
  const invalidate = useInvalidateTimber();
  return useMutation(orpc.timber.setPrice.mutationOptions({ onSuccess: invalidate }));
}
