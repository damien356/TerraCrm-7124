import { useMutation, useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/api";

/**
 * One app, two sides. `whoami` says which: an admin login gets the Office tab
 * on top of the crew screens, an installer login only ever sees his own work.
 * The server gates every route as well, so this only decides what is drawn.
 */
export function useWhoami() {
  return useQuery(orpc.devices.whoami.queryOptions({ staleTime: 60_000, retry: false }));
}

export function useMyDevices() {
  return useQuery(orpc.devices.myDevices.queryOptions({ retry: false }));
}

export function useTestPush() {
  return useMutation(orpc.devices.testPush.mutationOptions());
}
