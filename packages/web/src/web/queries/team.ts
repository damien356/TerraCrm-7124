import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useLogins() {
  return useQuery(orpc.team.list.queryOptions({ staleTime: 15_000 }));
}

function useTeamMutation(name: "setAccess" | "setCostAccess" | "updatePerson" | "setActive") {
  const queryClient = useQueryClient();
  return orpc.team[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.team.key() });
      queryClient.invalidateQueries({ queryKey: orpc.installers.key() });
    },
  });
}

export function useSetAccess() {
  return useMutation(useTeamMutation("setAccess"));
}

export function useSetCostAccess() {
  return useMutation(useTeamMutation("setCostAccess"));
}

export function useUpdatePerson() {
  return useMutation(useTeamMutation("updatePerson"));
}

export function useSetLoginActive() {
  return useMutation(useTeamMutation("setActive"));
}

export function useAddPerson() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.team.addPerson.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.team.key() });
        queryClient.invalidateQueries({ queryKey: orpc.installers.key() });
      },
    }),
  );
}

export function useUnlinkedCards(enabled: boolean) {
  return useQuery(orpc.team.unlinkedCards.queryOptions({ enabled, staleTime: 5_000 }));
}

/** What the phones have sent in: crashes, broken screens, logins they could not read. */
export function usePhoneProblems(limit = 50) {
  return useQuery(orpc.devices.problems.queryOptions({ input: { limit }, staleTime: 30_000 }));
}

/* -------------------- Archive, restore and delete people -------------------- */

export type PersonRef = { profileId: number } | { installerId: number };

function usePeopleChange() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.team.key() });
    queryClient.invalidateQueries({ queryKey: orpc.installers.key() });
    queryClient.invalidateQueries({ queryKey: orpc.calendar.key() });
    queryClient.invalidateQueries({ queryKey: orpc.abnCheck.key() });
  };
}

/** Installer cards nobody logs in with. */
export function useCardsWithoutLogin() {
  return useQuery(orpc.team.cardsWithoutLogin.queryOptions({ staleTime: 15_000 }));
}

/** Can they be deleted, or only archived, and what bookings are still ahead. Read only. */
export function usePersonCheck(ref: PersonRef | null) {
  return useQuery(
    orpc.team.personCheck.queryOptions({
      input: ref ?? { profileId: 0 },
      enabled: ref !== null,
      staleTime: 0,
    }),
  );
}

export function useArchivePerson() {
  const changed = usePeopleChange();
  return useMutation(orpc.team.archive.mutationOptions({ onSuccess: changed }));
}

export function useDeletePerson() {
  const changed = usePeopleChange();
  return useMutation(orpc.team.deletePerson.mutationOptions({ onSuccess: changed }));
}

export function useSetCanRestore() {
  const changed = usePeopleChange();
  return useMutation(orpc.team.setCanRestore.mutationOptions({ onSuccess: changed }));
}

export function useArchivedPeople() {
  return useQuery(orpc.team.archivedList.queryOptions({ staleTime: 5_000 }));
}

export function useRestorePerson() {
  const changed = usePeopleChange();
  return useMutation(orpc.team.restore.mutationOptions({ onSuccess: changed }));
}
