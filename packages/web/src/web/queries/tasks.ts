import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** The dispatch board: scheduled tasks in the window + the unassigned queue. */
export function useBoard(from: string, to: string) {
  return useQuery(
    orpc.tasks.board.queryOptions({ input: { from, to }, staleTime: 10_000, refetchInterval: 45_000 }),
  );
}

export function useTask(id: number | null) {
  return useQuery(
    orpc.tasks.get.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 10_000 }),
  );
}

/**
 * What a booking would land on: the dates, each day's availability and any
 * clash. Re-runs as the office changes the installer, the start or the day
 * count, so the panel always shows the live answer.
 */
export function usePlanBooking(input: {
  taskId: number | null;
  installerId: number | null;
  startDate: string;
  days: number;
  skipNonWorking: boolean;
  excludeDates: string[];
}) {
  return useQuery(
    orpc.tasks.planBooking.queryOptions({
      input: {
        taskId: input.taskId ?? 0,
        installerId: input.installerId,
        startDate: input.startDate,
        days: input.days,
        skipNonWorking: input.skipNonWorking,
        excludeDates: input.excludeDates,
      },
      enabled: input.taskId !== null && Boolean(input.startDate),
      staleTime: 5_000,
    }),
  );
}

/** Anything that moves a task invalidates the board, the job and the offer lists. */
function useTaskMutation(
  name:
    | "create"
    | "update"
    | "reschedule"
    | "assign"
    | "book"
    | "unassign"
    | "setStatus"
    | "remove"
    | "addChecklistItem"
    | "removeChecklistItem",
) {
  const queryClient = useQueryClient();
  return orpc.tasks[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
      queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
      queryClient.invalidateQueries({ queryKey: orpc.offers.key() });
      queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() });
    },
  });
}

export function useCreateTask() {
  return useMutation(useTaskMutation("create"));
}
export function useUpdateTask() {
  return useMutation(useTaskMutation("update"));
}
export function useRescheduleTask() {
  return useMutation(useTaskMutation("reschedule"));
}
export function useAssignTask() {
  return useMutation(useTaskMutation("assign"));
}
/** One day or a run of days, booked in a single write. */
export function useBookTask() {
  return useMutation(useTaskMutation("book"));
}
export function useUnassignTask() {
  return useMutation(useTaskMutation("unassign"));
}
export function useSetTaskStatus() {
  return useMutation(useTaskMutation("setStatus"));
}
export function useRemoveTask() {
  return useMutation(useTaskMutation("remove"));
}
export function useAddChecklistItem() {
  return useMutation(useTaskMutation("addChecklistItem"));
}
export function useRemoveChecklistItem() {
  return useMutation(useTaskMutation("removeChecklistItem"));
}
