import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/* Installers & bookings on the job page (Damien, 11 Nov 2026, job 188070). */

/** The job's labour lines, a card per person, the counts, and quote labour on no dispatch. */
export function useInstallerBoard(jobId: number) {
  return useQuery(orpc.installerBoard.board.queryOptions({ input: { jobId }, enabled: jobId > 0, staleTime: 5_000 }));
}

/** Everyone current, judged on the ticked lines only. Writes nothing. */
export function useBoardPeople(jobId: number, lineIds: number[]) {
  return useQuery(
    orpc.installerBoard.people.queryOptions({
      input: { jobId, lineIds },
      enabled: jobId > 0 && lineIds.length > 0,
      staleTime: 10_000,
      placeholderData: keepPreviousData,
    }),
  );
}

/** Everything on the page that shows who has the work. */
export function useBoardRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [
      orpc.installerBoard.key(),
      orpc.dispatches.key(),
      orpc.tasks.key(),
      orpc.jobs.key(),
      orpc.offers.key(),
      orpc.costing.key(),
      orpc.dashboard.key(),
    ]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

/** Gives ticked lines to one person as a draft. Sends no offer and no message. */
export function useBoardAssign() {
  const refresh = useBoardRefresh();
  return useMutation(orpc.installerBoard.assign.mutationOptions({ onSuccess: refresh }));
}

/** Puts quote labour that is on no dispatch back on the job. */
export function useRestoreLabour() {
  const refresh = useBoardRefresh();
  return useMutation(orpc.installerBoard.restoreLabour.mutationOptions({ onSuccess: refresh }));
}
