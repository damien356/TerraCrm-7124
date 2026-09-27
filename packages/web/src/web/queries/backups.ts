import { useMutation, useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Phase 0 — what can be pulled out, with live row counts. */
export function useDatasets() {
  return useQuery(orpc.backups.datasets.queryOptions({ staleTime: 30_000 }));
}

export function useExportCsv() {
  return useMutation(orpc.backups.csv.mutationOptions());
}

export function useExportSnapshot() {
  return useMutation(orpc.backups.snapshot.mutationOptions());
}

/** Turns text from the server into a file on Damien's machine. */
export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
