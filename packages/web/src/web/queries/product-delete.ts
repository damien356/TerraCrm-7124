import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** 15 Oct. Settings, Price list: delete products, undo last delete, the delete log. Admin only. */

/** A delete or an undo changes the list everywhere products are picked. */
function useRefresh() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: orpc.settings.products.key() }),
      qc.invalidateQueries({ queryKey: orpc.products.key() }),
      qc.invalidateQueries({ queryKey: orpc.productDelete.key() }),
    ]);
}

export function useProductDeletePreview(ids: number[] | null) {
  return useQuery(
    orpc.productDelete.preview.queryOptions({
      input: { ids: ids ?? [] },
      enabled: !!ids?.length,
      staleTime: 0,
      gcTime: 0,
      retry: false,
    }),
  );
}

export function useProductDeleteApply() {
  const refresh = useRefresh();
  return useMutation(orpc.productDelete.apply.mutationOptions({ onSuccess: () => refresh() }));
}

export function useProductDeleteUndo() {
  const refresh = useRefresh();
  return useMutation(orpc.productDelete.undoLast.mutationOptions({ onSuccess: () => refresh() }));
}

export function useProductDeleteLog(enabled: boolean) {
  return useQuery(orpc.productDelete.log.queryOptions({ enabled, staleTime: 5_000 }));
}

export function useProductDeleteRows(deleteId: number | null) {
  return useQuery(
    orpc.productDelete.rows.queryOptions({ input: { deleteId: deleteId ?? 0 }, enabled: deleteId !== null, staleTime: 30_000 }),
  );
}
