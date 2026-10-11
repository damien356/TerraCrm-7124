import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useSuppliers(includeInactive = false) {
  return useQuery(orpc.suppliers.list.queryOptions({ input: { includeInactive }, staleTime: 30_000 }));
}

export function useSupplier(id: number | null) {
  return useQuery(
    orpc.suppliers.get.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 15_000 }),
  );
}

function useInvalidateSuppliers() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.suppliers.key() });
}

// One hook per procedure so each mutation keeps its own input type. A shared
// helper keyed by a union of names typed every input as the supplier update.
export function useCreateSupplier() {
  const onSuccess = useInvalidateSuppliers();
  return useMutation(orpc.suppliers.create.mutationOptions({ onSuccess }));
}
export function useUpdateSupplier() {
  const onSuccess = useInvalidateSuppliers();
  return useMutation(orpc.suppliers.update.mutationOptions({ onSuccess }));
}
/**
 * LEGACY. Only writes the superseded percentage columns on the supplier row.
 * A fuel surcharge is a charge rule now. Use `useCreateSupplierFee` with
 * kind "fuel", so it can be charged per lineal metre or per m2 as well.
 */
export function useSetFuelSurcharge() {
  const onSuccess = useInvalidateSuppliers();
  return useMutation(orpc.suppliers.setFuelSurcharge.mutationOptions({ onSuccess }));
}
export function useCreateSupplierFee() {
  const onSuccess = useInvalidateSuppliers();
  return useMutation(orpc.suppliers.feeCreate.mutationOptions({ onSuccess }));
}
export function useUpdateSupplierFee() {
  const onSuccess = useInvalidateSuppliers();
  return useMutation(orpc.suppliers.feeUpdate.mutationOptions({ onSuccess }));
}
export function useDeleteSupplierFee() {
  const onSuccess = useInvalidateSuppliers();
  return useMutation(orpc.suppliers.feeDelete.mutationOptions({ onSuccess }));
}

/**
 * Live "what does this order really cost" preview for the selected supplier.
 * The quantities are the order measured in every unit a charge can be quoted
 * per, because each charge reads only the one its own basis names.
 */
export function useSupplierOrderCost(input: {
  supplierId: number | null;
  goodsExGst: number;
  m2: number;
  lm: number;
  boxes: number;
  rolls: number;
  items: number;
  pallets: number;
  shipments: number;
  weeksStored: number;
  /** Terra's own carrier leg, kept out of the supplier's charges. */
  transportExGst: number;
  feeIds: number[];
}) {
  return useQuery(
    orpc.suppliers.quoteOrderCost.queryOptions({
      input: { ...input, supplierId: input.supplierId ?? 0 },
      enabled: input.supplierId !== null,
      staleTime: 0,
    }),
  );
}
