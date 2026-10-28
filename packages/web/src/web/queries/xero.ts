import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Settings, Xero. No token ever reaches the browser. */

export function useXeroStatus() {
  return useQuery(orpc.xero.status.queryOptions({ staleTime: 10_000 }));
}

/** For the job page: is Xero connected, and to which organisation. */
export function useXeroReady(enabled = true) {
  return useQuery(orpc.xero.ready.queryOptions({ staleTime: 60_000, enabled }));
}

function useXeroRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.xero.key() });
    queryClient.invalidateQueries({ queryKey: orpc.clientInvoices.key() });
    queryClient.invalidateQueries({ queryKey: orpc.finance.key() });
  };
}

/** Returns Xero's sign-in link. The page then goes there. */
export const useConnectXero = () => useMutation(orpc.xero.connect.mutationOptions());
export const useChooseXeroTenant = () => useMutation(orpc.xero.chooseTenant.mutationOptions({ onSuccess: useXeroRefresh() }));
export const useDisconnectXero = () => useMutation(orpc.xero.disconnect.mutationOptions({ onSuccess: useXeroRefresh() }));
export const useSaveXeroSettings = () => useMutation(orpc.xero.saveSettings.mutationOptions({ onSuccess: useXeroRefresh() }));
export const usePushToXero = () => useMutation(orpc.xero.push.mutationOptions({ onSuccess: useXeroRefresh() }));
export const useCheckXeroNow = () => useMutation(orpc.xero.checkNow.mutationOptions({ onSuccess: useXeroRefresh() }));
