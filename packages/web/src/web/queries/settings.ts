import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Actor + skills + statuses + kv settings in one round trip. */
export function useBootstrap() {
  return useQuery(orpc.settings.bootstrap.queryOptions({ staleTime: 60_000, retry: false }));
}

function useSettingsMutation<T extends "skillCreate" | "skillUpdate" | "statusCreate" | "statusUpdate" | "set">(
  name: T,
) {
  const queryClient = useQueryClient();
  return orpc.settings[name].mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.settings.key() }),
  });
}

export function useCreateSkill() {
  return useMutation(useSettingsMutation("skillCreate"));
}
export function useUpdateSkill() {
  return useMutation(useSettingsMutation("skillUpdate"));
}
export function useCreateStatus() {
  return useMutation(useSettingsMutation("statusCreate"));
}
export function useUpdateStatus() {
  return useMutation(useSettingsMutation("statusUpdate"));
}
export function useSetSetting() {
  return useMutation(useSettingsMutation("set"));
}

export function useProducts() {
  return useQuery(orpc.settings.products.queryOptions({ staleTime: 60_000 }));
}

export function useCreateProduct() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.settings.productCreate.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.settings.products.key() }),
    }),
  );
}

export function useUpdateProduct() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.settings.productUpdate.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.settings.products.key() }),
    }),
  );
}

/** Job numbering: the start Admin set, the next number, the lowest start allowed. */
export function useJobNumbering() {
  return useQuery(orpc.settings.jobNumbering.queryOptions({ retry: false }));
}

export function useSetJobNumberStart() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.settings.setJobNumberStart.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.settings.jobNumbering.key() }),
    }),
  );
}
