import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useInstallers(includeInactive = false) {
  return useQuery(orpc.installers.list.queryOptions({ input: { includeInactive }, staleTime: 30_000 }));
}

export function useInstaller(id: number | null) {
  return useQuery(
    orpc.installers.get.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 15_000 }),
  );
}

/**
 * Who can actually take this task: ticked for the skill, and flagged for
 * clashes, unavailability and whether they can cover a 2-man task alone.
 */
export function useEligible(skillId: number | null, date?: string, crewSize = 1) {
  return useQuery(
    orpc.installers.eligible.queryOptions({
      input: { skillId: skillId ?? 0, date, crewSize },
      enabled: skillId !== null,
      staleTime: 5_000,
    }),
  );
}

export function useExpiringDocs() {
  return useQuery(orpc.installers.expiring.queryOptions({ staleTime: 60_000 }));
}

export function useInstallerLoad(from: string, to: string) {
  return useQuery(orpc.installers.load.queryOptions({ input: { from, to }, staleTime: 20_000 }));
}

function useInstallerMutation(name: "create" | "update" | "setSkill") {
  const queryClient = useQueryClient();
  return orpc.installers[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.installers.key() });
      queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
    },
  });
}

export function useCreateInstaller() {
  return useMutation(useInstallerMutation("create"));
}
export function useUpdateInstaller() {
  return useMutation(useInstallerMutation("update"));
}
/** Tick/untick a skill on the installer card, with their own rate for it. */
export function useSetInstallerSkill() {
  return useMutation(useInstallerMutation("setSkill"));
}
