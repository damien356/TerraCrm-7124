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

/** Anything that moves a task invalidates the board, the job and the offer lists. */
function useTaskMutation(
  name: "create" | "update" | "reschedule" | "assign" | "unassign" | "setStatus" | "remove" | "addChecklistItem" | "removeChecklistItem",
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
