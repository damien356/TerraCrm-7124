import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useLogins() {
  return useQuery(orpc.team.list.queryOptions({ staleTime: 15_000 }));
}

export function useUnlinkedInstallers() {
  return useQuery(orpc.team.unlinkedInstallers.queryOptions({ staleTime: 15_000 }));
}

function useTeamMutation(name: "link" | "setRole" | "setActive") {
  const queryClient = useQueryClient();
  return orpc.team[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.team.key() });
      queryClient.invalidateQueries({ queryKey: orpc.installers.key() });
    },
  });
}

export function useLinkLogin() {
  return useMutation(useTeamMutation("link"));
}

export function useSetLoginRole() {
  return useMutation(useTeamMutation("setRole"));
}

export function useSetLoginActive() {
  return useMutation(useTeamMutation("setActive"));
}
