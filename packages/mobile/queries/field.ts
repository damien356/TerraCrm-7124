import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "@/lib/api";

/**
 * Every hook here hits `orpc.field.*` — the only installer-scoped router.
 * Nothing on this app ever touches jobs/quotes/tasks routes: the server would
 * reject it anyway, but keeping it to `field` means no customer pricing can
 * ever leak onto a phone.
 */

export function useMe() {
  return useQuery(orpc.field.me.queryOptions({ staleTime: 60_000, retry: false }));
}

export function useToday() {
  return useQuery(orpc.field.today.queryOptions({ refetchInterval: 60_000 }));
}

export function useUpcoming() {
  return useQuery(orpc.field.upcoming.queryOptions({ input: {}, refetchInterval: 120_000 }));
}

/** Same feed, a custom window — what the calendar's week and month views page through. */
export function useScheduleRange(from: string, to: string) {
  return useQuery(orpc.field.upcoming.queryOptions({ input: { from, to } }));
}

export function useHistory() {
  return useQuery(orpc.field.history.queryOptions());
}

export function useTask(id: number) {
  return useQuery(orpc.field.task.queryOptions({ input: { id }, enabled: Number.isFinite(id) }));
}

export function useOffers() {
  return useQuery(orpc.field.offers.queryOptions({ refetchInterval: 30_000 }));
}

/** Everything that changes state invalidates the whole field router — small payloads, always fresh. */
function useInvalidateField() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.field.key() });
}

export function useAcceptOffer() {
  const invalidate = useInvalidateField();
  return useMutation(orpc.field.accept.mutationOptions({ onSuccess: invalidate }));
}

export function useDeclineOffer() {
  const invalidate = useInvalidateField();
  return useMutation(orpc.field.decline.mutationOptions({ onSuccess: invalidate }));
}

export function useReleaseTask() {
  const invalidate = useInvalidateField();
  return useMutation(orpc.field.release.mutationOptions({ onSuccess: invalidate }));
}

export function useStartTask() {
  const invalidate = useInvalidateField();
  return useMutation(orpc.field.start.mutationOptions({ onSuccess: invalidate }));
}

export function useCompleteTask() {
  const invalidate = useInvalidateField();
  return useMutation(orpc.field.complete.mutationOptions({ onSuccess: invalidate }));
}

export function useTickChecklistItem() {
  const invalidate = useInvalidateField();
  return useMutation(orpc.field.tickChecklistItem.mutationOptions({ onSuccess: invalidate }));
}

/**
 * Location sharing — ON-SHIFT ONLY. The switch belongs to the installer, on
 * their Me screen; turning it off deletes every position the office holds.
 */
export function useSetLocationConsent() {
  const invalidate = useInvalidateField();
  return useMutation(orpc.field.setLocationConsent.mutationOptions({ onSuccess: invalidate }));
}

/** One position ping. The server rejects it unless a job is actually running. */
export function usePingLocation() {
  return useMutation(orpc.field.pingLocation.mutationOptions());
}

/** The job file — plans, access, areas, damage, findings, completion, defects. */
export function useJobFile(taskId: number) {
  return useQuery(orpc.field.jobFile.queryOptions({ input: { taskId }, enabled: Number.isFinite(taskId) }));
}

export function useAddMedia() {
  const invalidate = useInvalidateField();
  return useMutation(orpc.field.addMedia.mutationOptions({ onSuccess: invalidate }));
}

/** "Walked it, nothing already damaged" — unlocks Start job. */
export function useNoDamage() {
  const invalidate = useInvalidateField();
  return useMutation(orpc.field.noDamage.mutationOptions({ onSuccess: invalidate }));
}

export function useAddFieldNote() {
  const invalidate = useInvalidateField();
  return useMutation(orpc.field.addNote.mutationOptions({ onSuccess: invalidate }));
}
