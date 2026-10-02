import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** The email agent's three mailboxes. No token ever reaches the browser. */

export function useMailStatus() {
  return useQuery(orpc.mail.status.queryOptions({ staleTime: 10_000 }));
}

/** Returns the Google sign-in link. The page then goes there. */
export const useConnectMailbox = () => useMutation(orpc.mail.connect.mutationOptions());

function useMailRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.mail.key() });
    queryClient.invalidateQueries({ queryKey: orpc.payables.key() });
  };
}

export const useDisconnectMailbox = () => useMutation(orpc.mail.disconnect.mutationOptions({ onSuccess: useMailRefresh() }));
export const useCheckMailNow = () => useMutation(orpc.mail.checkNow.mutationOptions({ onSuccess: useMailRefresh() }));
export const useSetPriceSms = () => useMutation(orpc.mail.setPriceSms.mutationOptions({ onSuccess: useMailRefresh() }));
