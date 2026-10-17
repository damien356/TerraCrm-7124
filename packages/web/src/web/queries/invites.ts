import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* Staff invites (notes 18.55): People, Settings, /app and /setup/<token>. */

export function useSendInvite() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.invites.send.mutationOptions({
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey: orpc.team.key() });
        queryClient.invalidateQueries({ queryKey: orpc.invites.key() });
      },
    }),
  );
}

export function useAppLinksAdmin() {
  return useQuery(orpc.invites.linksGet.queryOptions({ staleTime: 10_000 }));
}

export function useSaveAppLinks() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.invites.linksSave.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.invites.key() }),
    }),
  );
}

/** Public: the download page. */
export function usePublicAppLinks() {
  return useQuery(orpc.invites.appLinks.queryOptions({ staleTime: 60_000, retry: 1 }));
}

/** Public: is this set-up link still good. */
export function useInviteCheck(token: string) {
  return useQuery(orpc.invites.check.queryOptions({ input: { token }, staleTime: 0, retry: 1 }));
}

export function useInviteSetup() {
  return useMutation(orpc.invites.setup.mutationOptions());
}

/* Admin sets a password on a login, and the store reviewer login (notes 18.58). */

export function useSetPassword() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.invites.setPassword.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.team.key() }),
    }),
  );
}

export function useReviewerLogin() {
  return useQuery(orpc.invites.reviewer.queryOptions({ staleTime: 15_000 }));
}

export function useReviewerSetPassword() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.invites.reviewerSetPassword.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.invites.reviewer.key() }),
    }),
  );
}
