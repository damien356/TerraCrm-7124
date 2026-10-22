import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Hourly time, from the office side. Checking, correcting and approving time
 * is open to Office; dollar figures come back only for a login that may see
 * costs. Vehicles and the job costing card need costs; settings and pay terms
 * are Admin only. The server enforces every one of these.
 */

export type QueueStatus = "open" | "recorded" | "approved" | "rejected" | "todo" | "all";

export function useHourlyQueue(input: { status?: QueueStatus; installerId?: number; jobId?: number; taskId?: number; from?: string; to?: string }) {
  return useQuery(orpc.hourly.queue.queryOptions({ input: { status: input.status ?? "todo", ...input }, staleTime: 5_000 }));
}

export function useTimeHistory(sessionId: number | null) {
  return useQuery(orpc.hourly.history.queryOptions({ input: { sessionId: sessionId ?? 0 }, enabled: sessionId != null }));
}

export function useHourlyWorkers() {
  return useQuery(orpc.hourly.workers.queryOptions({ staleTime: 30_000 }));
}

export function useWorkerTasks(installerId: number | null) {
  return useQuery(orpc.hourly.workerTasks.queryOptions({ input: { installerId: installerId ?? 0 }, enabled: installerId != null }));
}

export function useVehicleNames() {
  return useQuery(orpc.hourly.vehicleNames.queryOptions({ staleTime: 30_000 }));
}

export function useHourlyJob(jobId: number | null, enabled = true) {
  return useQuery(orpc.hourly.job.queryOptions({ input: { jobId: jobId ?? 0 }, enabled: enabled && jobId != null, staleTime: 5_000, retry: false }));
}

export function useVehicles(enabled = true) {
  return useQuery(orpc.hourly.vehicles.queryOptions({ enabled, retry: false }));
}

export function useHourlySettings(enabled = true) {
  return useQuery(orpc.hourly.settings.queryOptions({ enabled, retry: false }));
}

export function usePayTerms(installerId: number | null, enabled = true) {
  return useQuery(orpc.hourly.terms.queryOptions({ input: { installerId: installerId ?? 0 }, enabled: enabled && installerId != null, retry: false }));
}

/** Every change to time can move the job card, the forecast and the invoice preview. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.hourly.key() });
    queryClient.invalidateQueries({ queryKey: orpc.costing.key() });
    queryClient.invalidateQueries({ queryKey: orpc.installerInvoices.key() });
  };
}

export function useCorrectTime() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.correct.mutationOptions({ onSuccess }));
}

export function useDecideBreak() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.decideBreak.mutationOptions({ onSuccess }));
}

export function useConfirmBand() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.confirmBand.mutationOptions({ onSuccess }));
}

export function useApproveTime() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.approve.mutationOptions({ onSuccess }));
}

export function useUnapproveTime() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.unapprove.mutationOptions({ onSuccess }));
}

export function useRejectTime() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.reject.mutationOptions({ onSuccess }));
}

export function useManualTime() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.manual.mutationOptions({ onSuccess }));
}

export function useTaskPlan() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.plan.mutationOptions({ onSuccess }));
}

export function useVehicleShare() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.vehicleShare.mutationOptions({ onSuccess }));
}

export function useSaveVehicle() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.saveVehicle.mutationOptions({ onSuccess }));
}

export function useSaveHourlySettings() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.saveSettings.mutationOptions({ onSuccess }));
}

export function useAddPayTerms() {
  const onSuccess = useRefresh();
  return useMutation(orpc.hourly.addTerms.mutationOptions({ onSuccess }));
}

/* ---------- display helpers, Brisbane time ---------- */

const TZ = "Australia/Brisbane";

export const hm = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) : "not finished";

export const dayLabel = (ymd: string) =>
  new Date(`${ymd}T12:00:00+10:00`).toLocaleDateString("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });

export const hours = (minutes: number | null | undefined) => {
  if (minutes == null) return "-";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

export const money = (n: number | null | undefined) =>
  n == null ? "-" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "2026-10-19T07:00" in Brisbane (no daylight saving) to an ISO instant. */
export const fromLocalInput = (v: string) => (v ? `${v.length === 16 ? `${v}:00` : v}+10:00` : "");

/** An ISO instant to the value a datetime-local input wants, in Brisbane. */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 10 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 16);
};

export const STATUS_LABEL: Record<string, string> = {
  open: "Running",
  recorded: "To check",
  approved: "Approved",
  rejected: "Rejected",
};

export const STATUS_COLOUR: Record<string, string> = {
  open: "#2F6690",
  recorded: "#B7791F",
  approved: "#3E6B4F",
  rejected: "#8A8580",
};
