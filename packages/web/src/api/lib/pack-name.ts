/**
 * Pack name on products (Damien, 2 Nov). No server imports here, so the
 * quote builder, the products page and the PO screen use the same words.
 *
 * His rules:
 *  - A product's pack is a Box, Sheet, Carton or Bag. Box is the default and
 *    every product on file is a Box, so nothing sold today changes.
 *  - Sheet, Carton and Bag are counted packs. The qty is
 *    (measured m2 x (1 + wastage %)) / m2 per pack, always rounded UP to a
 *    whole pack. The quote line reads "10 sheets (10.80 m²)", 2 decimals.
 *  - The supplier PO is in whole packs at the pack price:
 *    "10 sheets @ $15.50 = $155.00".
 *  - The client copy shows m2 by default. A line can be switched to packs.
 *  - A sheet underlay (Gibbon SureBoard Wet, 900 x 1200 x 5mm = 1.08 m2)
 *    follows the vinyl (and cork, which is vinyl in the price book) floor
 *    line, and its install goes on with it at the m2 of the sheets supplied.
 */

export const PACK_NAMES = ["box", "sheet", "carton", "bag"] as const;
export type PackName = (typeof PACK_NAMES)[number];

export const PACK_LABELS: Record<PackName, string> = { box: "Box", sheet: "Sheet", carton: "Carton", bag: "Bag" };
const PLURALS: Record<PackName, string> = { box: "boxes", sheet: "sheets", carton: "cartons", bag: "bags" };

export const isPackName = (v: unknown): v is PackName => typeof v === "string" && (PACK_NAMES as readonly string[]).includes(v);

/** The product's pack name. Anything unset or unknown reads as Box. */
export const packNameOf = (p: { packName?: string | null } | null | undefined): PackName =>
  isPackName(p?.packName) ? p.packName : "box";

/** Sheet, carton or bag: ordered and shown in whole packs. Box stays exactly as it always was. */
export const isCountedPack = (p: { packName?: string | null } | null | undefined) => packNameOf(p) !== "box";

/** "sheet" or "sheets". */
export const packWord = (name: PackName, n: number) => (n === 1 ? name : PLURALS[name]);

/** "10 sheets". */
export const packCount = (name: PackName, n: number) => `${n} ${packWord(name, n)}`;

/** Whole packs for an m2, always rounded up. */
export const packsFor = (m2: number, packM2: number) => Math.ceil(m2 / packM2 - 1e-9);

/** m2 on whole packs, rounded down to 4 places so it never sits a hair over the packs. */
export const packedM2 = (packs: number, packM2: number) => Math.floor(packs * packM2 * 10_000 + 1e-6) / 10_000;

/** "10 sheets (10.80 m²)". Counted packs only; box goods keep their own wording. */
export const packsNote = (name: PackName, packs: number, m2: number) => `${packCount(name, packs)} (${m2.toFixed(2)} m²)`;

/** A line or PO unit that is a pack word: "sheet", "carton", "bag", "box". */
export const isPackUnit = (u: string | null | undefined) => isPackName(u);

/** How a unit reads next to a qty: "m²", "10 sheets", "1 sheet". Other units as they are. */
export function unitText(unit: string, qty?: number | null): string {
  if (unit === "m2") return "m²";
  if (isPackName(unit) && qty != null) return packWord(unit, Math.abs(qty - 1) < 1e-9 ? 1 : 2);
  return unit;
}

/* --------------------------- sheet underlay ------------------------------ */

/** Floors a counted-pack hard floor underlay follows: vinyl (cork floors are vinyl in the price book). */
export const SHEET_UNDERLAY_FLOORS = ["vinyl"] as const;

/**
 * Rate book item for the sheet underlay install, $20/m2 standard (Damien,
 * 2 Nov). Added with the pack name change and found by this name, so its id
 * can differ between copies of the database. Goes on a sheet underlay line by
 * default, at the m2 of the sheets on the line. Renamed in the rate book, the
 * line is flagged "Install not added" instead.
 */
export const SHEET_UNDERLAY_INSTALL_NAME = "Install sheet underlay";

/** A hard floor underlay sold by the counted pack (SureBoard Wet): follows vinyl, rounds to whole sheets. */
export const isSheetUnderlay = (p: { category?: string | null; packName?: string | null; soldAs?: string | null }) =>
  p.category === "hard_floor_underlay" && isCountedPack(p);
