/**
 * The Sizes line on a board product: "2200 x 194 x 12mm", 5 per carton, 2.134 m².
 *
 * Damien, 13 Oct: the price list import filled board width and box m² but not
 * the Sizes, so new colours showed "-". The size text and the area of one board
 * are worked out here from length x width (x thickness), so the import, the
 * Sizes box in Settings and the price book all agree.
 *
 * Pure code. Safe to import from the web side.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const pos = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** "2200 x 194 x 12mm". Null unless length and width are both known. */
export function boardSizeText(lengthMm: number | null | undefined, widthMm: number | null | undefined, thicknessMm?: number | null) {
  if (!pos(lengthMm) || !pos(widthMm)) return null;
  const parts = [lengthMm, widthMm, ...(pos(thicknessMm) ? [thicknessMm] : [])].map((n) => String(r2(n)));
  return `${parts.join(" x ")}mm`;
}

/** Area of one board in m², 4 places. 2200 x 194 = 0.4268. */
export function boardM2(lengthMm: number | null | undefined, widthMm: number | null | undefined) {
  if (!pos(lengthMm) || !pos(widthMm)) return null;
  return r4((lengthMm * widthMm) / 1_000_000);
}

type Dims = {
  size: string;
  lengthMm: number | null;
  widthMm: number | null;
  thicknessMm: number | null;
  unitM2: number | null;
};

const differs = (a: number | null | undefined, b: number | null | undefined) =>
  a !== undefined && !((a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.0005));

/**
 * What `size` and `unitM2` become when the board measurements are set.
 * `next` holds only what is being changed. Returns only the fields that move.
 *
 * - Size text: filled when it is blank, or rewritten when length, width or
 *   thickness changed. A size someone typed is kept while the numbers stay put.
 * - Board m²: filled when blank, or worked out again when length or width changed.
 */
export function derivedBoardFields(before: Partial<Dims>, next: Partial<Pick<Dims, "lengthMm" | "widthMm" | "thicknessMm">>) {
  const out: { size?: string; unitM2?: number } = {};
  const lengthMm = next.lengthMm !== undefined ? next.lengthMm : (before.lengthMm ?? null);
  const widthMm = next.widthMm !== undefined ? next.widthMm : (before.widthMm ?? null);
  const thicknessMm = next.thicknessMm !== undefined ? next.thicknessMm : (before.thicknessMm ?? null);
  const lwMoved = differs(next.lengthMm, before.lengthMm) || differs(next.widthMm, before.widthMm);
  const anyMoved = lwMoved || differs(next.thicknessMm, before.thicknessMm);

  const text = boardSizeText(lengthMm, widthMm, thicknessMm);
  if (text && text !== (before.size ?? "") && (!(before.size ?? "").trim() || anyMoved)) out.size = text;

  const m2 = boardM2(lengthMm, widthMm);
  if (m2 != null && (before.unitM2 == null || lwMoved) && !(before.unitM2 != null && Math.abs(before.unitM2 - m2) < 0.00005)) out.unitM2 = m2;
  return out;
}
