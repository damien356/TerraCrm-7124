import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * One hook per procedure, not a shared `useSegmentMutation(name)` helper. The
 * shared-helper pattern in the older query files takes a union of procedure
 * names, which collapses every mutation to the shape of one arbitrary member
 * of that union and makes the input and output types wrong at every call site.
 */

/** Every segment with its live counts. Slow on purpose — stale numbers are worse. */
export function useSegments() {
  return useQuery(orpc.segments.list.queryOptions({ staleTime: 15_000 }));
}

export function useSegment(id: number | null) {
  return useQuery(
    orpc.segments.get.queryOptions({ input: { id: id ?? 0 }, enabled: id !== null, staleTime: 15_000 }),
  );
}

/** Real suburbs, sources and product families, with real counts behind each. */
export function useSegmentOptions() {
  return useQuery(orpc.segments.options.queryOptions({ staleTime: 5 * 60_000 }));
}

/**
 * Counts and a sample for rules that have not been saved, so the editor shows
 * what a change does before anyone commits to it. Debounced by the caller.
 */
export function useSegmentPreview(input: {
  audience: "homeowner" | "builder";
  rules: Record<string, unknown>;
  enabled?: boolean;
}) {
  const { enabled = true, ...rest } = input;
  return useQuery(
    orpc.segments.preview.queryOptions({
      input: rest as Parameters<typeof orpc.segments.preview.queryOptions>[0]["input"],
      enabled,
      staleTime: 0,
    }),
  );
}

function useInvalidateSegments() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.segments.key() });
}

export function useCreateSegment() {
  const invalidate = useInvalidateSegments();
  return useMutation(orpc.segments.create.mutationOptions({ onSuccess: invalidate }));
}

export function useUpdateSegment() {
  const invalidate = useInvalidateSegments();
  return useMutation(orpc.segments.update.mutationOptions({ onSuccess: invalidate }));
}

export function useDeleteSegment() {
  const invalidate = useInvalidateSegments();
  return useMutation(orpc.segments.remove.mutationOptions({ onSuccess: invalidate }));
}

/* ---- Audience review: the human override on the homeowner/trade split ---- */

export function useAudienceReviewQueue(limit = 200) {
  return useQuery(
    orpc.segments.audienceReview.queue.queryOptions({ input: { limit }, staleTime: 15_000 }),
  );
}

/**
 * Recording a decision changes who every segment can reach, so this
 * invalidates the segment counts as well as the queue.
 */
export function useSetAudience() {
  const invalidate = useInvalidateSegments();
  return useMutation(orpc.segments.audienceReview.setAudience.mutationOptions({ onSuccess: invalidate }));
}
