import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Fix list 11 Oct, items 4 and 5. Settings, Price list import and export. Admin only. */

export function usePriceTemplate() {
  return useMutation(orpc.priceImport.template.mutationOptions());
}

export function usePriceExport() {
  return useMutation(orpc.priceImport.export.mutationOptions());
}

export function usePriceImportPreview() {
  return useMutation(orpc.priceImport.preview.mutationOptions());
}

/** After a confirm or an undo every price on screen may have moved. */
function useRefreshPrices() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: orpc.settings.products.key() }),
      qc.invalidateQueries({ queryKey: orpc.products.key() }),
      qc.invalidateQueries({ queryKey: orpc.priceImport.key() }),
    ]);
}

export function usePriceImportConfirm() {
  const refresh = useRefreshPrices();
  return useMutation(orpc.priceImport.confirm.mutationOptions({ onSuccess: () => refresh() }));
}

export function usePriceImportUndo() {
  const refresh = useRefreshPrices();
  return useMutation(orpc.priceImport.undoLast.mutationOptions({ onSuccess: () => refresh() }));
}

export function usePriceImportLog(enabled: boolean) {
  return useQuery(orpc.priceImport.log.queryOptions({ enabled, staleTime: 10_000 }));
}

export function usePriceImportRows(importId: number | null) {
  return useQuery(
    orpc.priceImport.rows.queryOptions({ input: { importId: importId ?? 0 }, enabled: importId !== null, staleTime: 30_000 }),
  );
}

/** Base64 from the server into a downloaded file. */
export function downloadBase64(filename: string, base64: string, mime: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** A picked file as what the API takes: CSV as text, Excel as base64. */
export async function readSheetFile(file: File): Promise<{ fileName: string; csv?: string; xlsxBase64?: string }> {
  const name = file.name || "price-list.csv";
  if (/\.xlsx$/i.test(name)) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { fileName: name, xlsxBase64: btoa(bin) };
  }
  return { fileName: name, csv: await file.text() };
}
