import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Deliberately NOT written with a shared `useTemplateMutation(name)` helper.
 *
 * That pattern — used by most of the older query files here — takes a union of
 * procedure names, so TypeScript collapses every mutation to the shape of one
 * arbitrary member of the union. The result is that the input and output types
 * are wrong everywhere it is used, which is where a large share of this
 * project's type errors come from. One hook per procedure keeps them exact.
 */

export function useTemplates(includeInactive = true) {
  return useQuery(orpc.templates.list.queryOptions({ input: { includeInactive }, staleTime: 15_000 }));
}

export function useTemplate(id: number | null) {
  return useQuery(
    orpc.templates.get.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 15_000 }),
  );
}

/**
 * Live render of whatever is in the editor, through the same function the real
 * send uses. Debounced by the caller, not here.
 */
export function useTemplatePreview(input: {
  subject: string;
  body: string;
  useWrapper: boolean;
  contactId?: number;
  enabled?: boolean;
}) {
  const { enabled = true, ...rest } = input;
  return useQuery(orpc.templates.preview.queryOptions({ input: rest, enabled, staleTime: 0 }));
}

/** Everything a write touches: the list, the record, and the usage counts. */
function useInvalidateTemplates() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.templates.key() });
}

export function useCreateTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation(orpc.templates.create.mutationOptions({ onSuccess: invalidate }));
}

export function useUpdateTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation(orpc.templates.update.mutationOptions({ onSuccess: invalidate }));
}

export function useDeleteTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation(orpc.templates.remove.mutationOptions({ onSuccess: invalidate }));
}

/** Goes to the signed-in staff member only. Never invalidates anything. */
export function useSendTestTemplate() {
  return useMutation(orpc.templates.sendTest.mutationOptions());
}
