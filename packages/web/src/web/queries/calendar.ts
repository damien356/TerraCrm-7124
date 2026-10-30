import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** My bookable card and Google calendar link, for Settings. */
export function useMyCalendar() {
  return useQuery(orpc.calendar.me.queryOptions({ staleTime: 10_000 }));
}

/** Office and Admin people and whether each is bookable. */
export function useStaffBookable(enabled = true) {
  return useQuery(orpc.calendar.staff.queryOptions({ staleTime: 30_000, enabled }));
}

/** Busy shading for the board. Times only. */
export function useCalendarBoard(from: string, to: string) {
  return useQuery(
    orpc.calendar.board.queryOptions({ input: { from, to }, staleTime: 60_000, refetchInterval: 5 * 60_000 }),
  );
}

export type CalendarCheckInput = {
  taskId: number | null;
  durationHours: number | null;
  days: Array<{ date: string; arrivalStart: string | null; arrivalEnd: string | null; coordinate: boolean; people: number[] }>;
};

/** The same check a booking runs, without booking. Re-runs as the panel changes. */
export function useCalendarCheck(input: CalendarCheckInput, enabled: boolean) {
  return useQuery(
    orpc.calendar.check.queryOptions({
      input,
      enabled: enabled && input.days.length > 0,
      staleTime: 15_000,
      placeholderData: (prev) => prev,
    }),
  );
}

export function useCalendarOverrides(installerId?: number) {
  return useQuery(orpc.calendar.overrides.queryOptions({ input: { installerId }, staleTime: 30_000 }));
}

function useCalMutation(name: "makeBookable" | "connectUrl" | "setCalendars" | "setBuffers" | "refresh" | "disconnect" | "stopChecking") {
  const qc = useQueryClient();
  return orpc.calendar[name].mutationOptions({
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orpc.calendar.key() });
      qc.invalidateQueries({ queryKey: orpc.installers.key() });
    },
  });
}

export const useMakeBookable = () => useMutation(useCalMutation("makeBookable"));
export const useCalendarConnectUrl = () => useMutation(useCalMutation("connectUrl"));
export const useSetCalendars = () => useMutation(useCalMutation("setCalendars"));
export const useSetBuffers = () => useMutation(useCalMutation("setBuffers"));
export const useRefreshCalendar = () => useMutation(useCalMutation("refresh"));
export const useDisconnectCalendar = () => useMutation(useCalMutation("disconnect"));
export const useStopCalendar = () => useMutation(useCalMutation("stopChecking"));
