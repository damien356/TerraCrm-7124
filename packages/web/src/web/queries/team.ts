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
