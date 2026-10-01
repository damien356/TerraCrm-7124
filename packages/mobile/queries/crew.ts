import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "@/lib/api";

/**
 * Hands-free crew: Siri settings, maps app, and site visits (arrived and left).
 * All of it is the installer's own, never another installer's.
 */

export function useVoiceSettings(enabled = true) {
  return useQuery(orpc.voice.settings.queryOptions({ enabled, retry: false, staleTime: 30_000 }));
}

export function useSetNavApp() {
  const qc = useQueryClient();
  return useMutation(
    orpc.voice.setNavApp.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: orpc.voice.key() }) }),
  );
}

/** Am I on site for this task, and is a day red for missing photos. */
export function useMyVisits(taskId: number, enabled = true) {
  return useQuery(
    orpc.visits.mine.queryOptions({
      input: { taskId },
      enabled: enabled && Number.isFinite(taskId),
      refetchInterval: 60_000,
    }),
  );
}

function useInvalidateVisits() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: orpc.visits.key() });
    void qc.invalidateQueries({ queryKey: orpc.field.key() });
  };
}

export function useTapArrived() {
  const invalidate = useInvalidateVisits();
  return useMutation(orpc.visits.enter.mutationOptions({ onSuccess: invalidate }));
}

export function useTapLeft() {
  const invalidate = useInvalidateVisits();
  return useMutation(orpc.visits.leave.mutationOptions({ onSuccess: invalidate }));
}
