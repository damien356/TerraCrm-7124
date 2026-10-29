import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* Installer Account tab (Task H). Office and Admin. Contras are Admin only and behind a server flag. */

export function useInstallerAccount(installerId: number) {
  return useQuery(orpc.installerAccount.overview.queryOptions({ input: { installerId }, staleTime: 5_000 }));
}

export function useXeroBills(installerId: number, enabled: boolean) {
  return useQuery(orpc.installerAccount.xeroBills.queryOptions({ input: { installerId }, enabled, staleTime: 0, retry: false }));
}

export function useXeroContactsForInstaller(installerId: number, enabled: boolean) {
  return useQuery(orpc.installerAccount.xeroContacts.queryOptions({ input: { installerId }, enabled, staleTime: 0, retry: false }));
}

export function useContraHistory(id: number, enabled: boolean) {
  return useQuery(orpc.installerAccount.contraHistory.queryOptions({ input: { id }, enabled, staleTime: 0 }));
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.installerAccount.key() });
    queryClient.invalidateQueries({ queryKey: orpc.quotes.key() });
    queryClient.invalidateQueries({ queryKey: orpc.clientInvoices.key() });
  };
}

/** Preview is read only. It changes nothing, so nothing to refresh. */
export function useContraPreview() {
  return useMutation(orpc.installerAccount.contraPreview.mutationOptions());
}

export function useLinkBuyer() {
  const refresh = useRefresh();
  return useMutation(orpc.installerAccount.link.mutationOptions({ onSuccess: refresh }));
}

export function useCreateBuyer() {
  const refresh = useRefresh();
  return useMutation(orpc.installerAccount.createBuyer.mutationOptions({ onSuccess: refresh }));
}

export function useUnlinkBuyer() {
  const refresh = useRefresh();
  return useMutation(orpc.installerAccount.unlink.mutationOptions({ onSuccess: refresh }));
}

export function useStartMaterials() {
  const refresh = useRefresh();
  return useMutation(orpc.installerAccount.startMaterials.mutationOptions({ onSuccess: refresh }));
}

export function usePinXero() {
  const refresh = useRefresh();
  return useMutation(orpc.installerAccount.pinXero.mutationOptions({ onSuccess: refresh }));
}

export function useContraPrepare() {
  const refresh = useRefresh();
  return useMutation(orpc.installerAccount.contraPrepare.mutationOptions({ onSuccess: refresh }));
}

export function useContraApprove() {
  const refresh = useRefresh();
  return useMutation(orpc.installerAccount.contraApprove.mutationOptions({ onSuccess: refresh }));
}

export function useContraPost() {
  const refresh = useRefresh();
  return useMutation(orpc.installerAccount.contraPost.mutationOptions({ onSuccess: refresh }));
}

export function useContraConfirm() {
  const refresh = useRefresh();
  return useMutation(orpc.installerAccount.contraConfirm.mutationOptions({ onSuccess: refresh }));
}

export function useContraCancel() {
  const refresh = useRefresh();
  return useMutation(orpc.installerAccount.contraCancel.mutationOptions({ onSuccess: refresh }));
}
