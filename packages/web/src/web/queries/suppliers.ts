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

function useSupplierMutation(
  name: "create" | "update" | "setFuelSurcharge" | "feeCreate" | "feeUpdate" | "feeDelete",
) {
  const queryClient = useQueryClient();
  return orpc.suppliers[name].mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.suppliers.key() }),
  });
}

export function useCreateSupplier() {
  return useMutation(useSupplierMutation("create"));
}
export function useUpdateSupplier() {
  return useMutation(useSupplierMutation("update"));
}
/**
 * LEGACY. Only writes the superseded percentage columns on the supplier row.
 * A fuel surcharge is a charge rule now — use `useCreateSupplierFee` with
 * kind "fuel", so it can be charged per lineal metre or per m2 as well.
 */
export function useSetFuelSurcharge() {
  return useMutation(useSupplierMutation("setFuelSurcharge"));
}
export function useCreateSupplierFee() {
  return useMutation(useSupplierMutation("feeCreate"));
}
export function useUpdateSupplierFee() {
  return useMutation(useSupplierMutation("feeUpdate"));
}
export function useDeleteSupplierFee() {
  return useMutation(useSupplierMutation("feeDelete"));
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
