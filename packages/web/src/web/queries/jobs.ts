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

function useJobMutation(
  name:
    | "create"
    | "update"
    | "addContact"
    | "updateContact"
    | "removeContact"
    | "addMaterial"
    | "updateMaterial"
    | "removeMaterial"
    | "addNote",
) {
  const queryClient = useQueryClient();
  return orpc.jobs[name].mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
      queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
      queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() });
    },
  });
}

export function useCreateJob() {
  return useMutation(useJobMutation("create"));
}
export function useUpdateJob() {
  return useMutation(useJobMutation("update"));
}
export function useAddJobContact() {
  return useMutation(useJobMutation("addContact"));
}
export function useUpdateJobContact() {
  return useMutation(useJobMutation("updateContact"));
}
export function useRemoveJobContact() {
  return useMutation(useJobMutation("removeContact"));
}
export function useAddMaterial() {
  return useMutation(useJobMutation("addMaterial"));
}
export function useUpdateMaterial() {
  return useMutation(useJobMutation("updateMaterial"));
}
export function useRemoveMaterial() {
  return useMutation(useJobMutation("removeMaterial"));
}
export function useAddJobNote() {
  return useMutation(useJobMutation("addNote"));
}
