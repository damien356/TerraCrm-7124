import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useFormTemplates() {
  return useQuery(orpc.forms.templates.queryOptions({ staleTime: 15_000 }));
}

export function useFormTemplate(id: number | null) {
  return useQuery(
    orpc.forms.template.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 15_000 }),
  );
}

export function useFormSubmissions(input: {
  status?: "pending" | "priced" | "approved" | "rejected" | "closed" | null;
  jobId?: number | null;
  kind?: "variation" | "prestart" | "defect" | "moisture" | "swms" | "toolbox" | "vehicle" | "custom" | null;
}) {
  return useQuery(
    orpc.forms.submissions.queryOptions({
      input: { status: input.status ?? null, jobId: input.jobId ?? null, kind: input.kind ?? null },
      staleTime: 10_000,
    }),
  );
}

export function useFormSubmission(id: number | null) {
  return useQuery(
    orpc.forms.submission.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 5_000 }),
  );
}

function useInvalidateForms() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: orpc.forms.key() });
  };
}

export function useCreateTemplate() {
  const invalidate = useInvalidateForms();
  return useMutation(orpc.forms.createTemplate.mutationOptions({ onSuccess: invalidate }));
}

export function useUpdateTemplate() {
  const invalidate = useInvalidateForms();
  return useMutation(orpc.forms.updateTemplate.mutationOptions({ onSuccess: invalidate }));
}

export function useRemoveTemplate() {
  const invalidate = useInvalidateForms();
  return useMutation(orpc.forms.removeTemplate.mutationOptions({ onSuccess: invalidate }));
}

export function useAddField() {
  const invalidate = useInvalidateForms();
  return useMutation(orpc.forms.addField.mutationOptions({ onSuccess: invalidate }));
}

export function useUpdateField() {
  const invalidate = useInvalidateForms();
  return useMutation(orpc.forms.updateField.mutationOptions({ onSuccess: invalidate }));
}

export function useRemoveField() {
  const invalidate = useInvalidateForms();
  return useMutation(orpc.forms.removeField.mutationOptions({ onSuccess: invalidate }));
}

export function useReviewSubmission() {
  const invalidate = useInvalidateForms();
  return useMutation(orpc.forms.review.mutationOptions({ onSuccess: invalidate }));
}

export function useSeedVariation() {
  const invalidate = useInvalidateForms();
  return useMutation(orpc.forms.seedVariation.mutationOptions({ onSuccess: invalidate }));
}
