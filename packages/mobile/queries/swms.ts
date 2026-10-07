import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "@/lib/api";

/**
 * SWMS for one of my tasks. The server picks the trade sections from the
 * job's labour (task skills), the installer can add or drop one, then signs.
 */
export function useSwmsForTask(taskId: number) {
  return useQuery(orpc.swms.forTask.queryOptions({ input: { taskId }, enabled: Number.isFinite(taskId) }));
}

/** Signing changes what Start and Finish allow, so refresh the task cards too. */
export function useSignSwms() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.swms.sign.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.swms.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.field.key() }),
        ]),
    }),
  );
}
