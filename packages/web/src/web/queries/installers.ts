import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "../lib/api";

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
/**
 * Everyone who could be booked, eligible first. With a task, the skills come
 * from its work lines (or the ticked ones), so nobody is dropped for the first
 * line's trade. People who can't take it come back with their reasons.
 */
export function useEligible(skillId: number | null, date?: string, crewSize = 1, task?: { taskId: number; itemIds?: number[] } | null) {
  return useQuery(
    orpc.installers.eligible.queryOptions({
      input: { skillId: skillId ?? null, taskId: task?.taskId, itemIds: task?.itemIds, date, crewSize },
      enabled: skillId !== null || Boolean(task?.taskId),
      staleTime: 5_000,
    }),
  );
}

/** People page: current cards with no worker type yet, for review. Admin only. */
export function useWorkerReview() {
  return useQuery(orpc.installers.workerReview.queryOptions({ staleTime: 15_000 }));
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
      queryClient.invalidateQueries({ queryKey: orpc.abnCheck.key() });
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

/**
 * The installer's business logo, uploaded by the office on their behalf.
 * Straight to storage from the browser, the API server never holds the file.
 */
export async function uploadInstallerLogo(file: File, installerId: number) {
  const { url, key } = await client.installers.presignLogo({
    installerId,
    filename: file.name,
    contentType: file.type || "image/png",
  });
  const res = await fetch(url, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "image/png" },
  });
  if (!res.ok) throw new Error("That logo didn't upload. Try again.");
  return key;
}
