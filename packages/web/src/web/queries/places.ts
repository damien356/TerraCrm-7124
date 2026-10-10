import { useMutation, useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Address autocomplete for new sites. Off (typed by hand) until the Google key is set. */

export function usePlacesEnabled() {
  return useQuery(orpc.places.enabled.queryOptions({ staleTime: 10 * 60_000 }));
}

export function usePlaceSuggestions(input: string, sessionToken: string, enabled: boolean) {
  return useQuery(
    orpc.places.autocomplete.queryOptions({
      input: { input, sessionToken },
      enabled: enabled && input.trim().length >= 3,
      staleTime: 60_000,
      placeholderData: (prev) => prev,
    }),
  );
}

export function usePlaceDetails() {
  return useMutation(orpc.places.details.mutationOptions());
}
