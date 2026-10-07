import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useJobs(input: {
  search?: string;
  statusId?: number;
  stage?: string;
  contactId?: number;
  companyId?: number;
} = {}) {
  return useQuery(orpc.jobs.list.queryOptions({ input, staleTime: 15_000 }));
}

export function useJob(id: number | null) {
  return useQuery(
    orpc.jobs.get.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 10_000 }),
  );
}

/*
 * One options object per hook. A shared helper indexed by a name union gave
 * every hook a union input type, which tsc resolved differently from build to
 * build (and so it rejected valid calls).
 */
function useJobRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
    queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() });
    // The PO card lists the job's materials.
    queryClient.invalidateQueries({ queryKey: orpc.purchasing.key() });
  };
}

export function useCreateJob() {
  const onSuccess = useJobRefresh();
  return useMutation(orpc.jobs.create.mutationOptions({ onSuccess }));
}
export function useUpdateJob() {
  const onSuccess = useJobRefresh();
  return useMutation(orpc.jobs.update.mutationOptions({ onSuccess }));
}
/** Sets, changes or clears the supervisor who sent the job. */
export function useSetJobSupervisor() {
  const onSuccess = useJobRefresh();
  return useMutation(orpc.jobs.setSupervisor.mutationOptions({ onSuccess }));
}
export function useAddMaterial() {
  const onSuccess = useJobRefresh();
  return useMutation(orpc.jobs.addMaterial.mutationOptions({ onSuccess }));
}
export function useUpdateMaterial() {
  const onSuccess = useJobRefresh();
  return useMutation(orpc.jobs.updateMaterial.mutationOptions({ onSuccess }));
}
export function useRemoveMaterial() {
  const onSuccess = useJobRefresh();
  return useMutation(orpc.jobs.removeMaterial.mutationOptions({ onSuccess }));
}
export function useAddJobNote() {
  const onSuccess = useJobRefresh();
  return useMutation(orpc.jobs.addNote.mutationOptions({ onSuccess }));
}
