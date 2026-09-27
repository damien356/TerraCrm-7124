import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Blackout dates for one installer. */
export function useUnavailability(installerId: number | null) {
  return useQuery(
    orpc.availability.list.queryOptions({
      input: { installerId: installerId ?? 0 },
      enabled: installerId !== null,
      staleTime: 15_000,
    }),
  );
}

/** Everything blocked across a window — the schedule board greys these out. */
export function useUnavailabilityInRange(from: string, to: string) {
  return useQuery(orpc.availability.inRange.queryOptions({ input: { from, to }, staleTime: 20_000 }));
}

function useAvailabilityMutation(name: "addFromText" | "add" | "remove") {
  const queryClient = useQueryClient();
  return orpc.availability[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.availability.key() });
      queryClient.invalidateQueries({ queryKey: orpc.installers.key() });
    },
  });
}

/** Plain English in, real blocked dates out. */
export function useAddUnavailabilityFromText() {
  return useMutation(useAvailabilityMutation("addFromText"));
}
export function useAddUnavailability() {
  return useMutation(useAvailabilityMutation("add"));
}
export function useRemoveUnavailability() {
  return useMutation(useAvailabilityMutation("remove"));
}
