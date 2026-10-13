import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Alerts nobody has cleared. The Dashboard card. Polls so a new one shows without a reload. */
export const useOpenAlerts = () => useQuery(orpc.alerts.open.queryOptions({ staleTime: 15_000, refetchInterval: 60_000 }));

function useAlertsRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: orpc.alerts.key() });
}

export const useClearAlert = () => useMutation(orpc.alerts.clear.mutationOptions({ onSuccess: useAlertsRefresh() }));

export const useClearAllAlerts = () => useMutation(orpc.alerts.clearAll.mutationOptions({ onSuccess: useAlertsRefresh() }));

/** Settings, Notifications. */
export const useNotifySettings = () => useQuery(orpc.alerts.settings.queryOptions());

export const useSaveNotifySettings = () => useMutation(orpc.alerts.saveSettings.mutationOptions({ onSuccess: useAlertsRefresh() }));

export const useSummaryPreview = (enabled: boolean) => useQuery(orpc.alerts.previewSummary.queryOptions({ enabled, staleTime: 0 }));

export const useSendSummaryNow = () => useMutation(orpc.alerts.sendSummaryNow.mutationOptions());
