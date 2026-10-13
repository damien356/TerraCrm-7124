/* ---------------------------------------------------------------------------
 * Fix list 11 Oct, item 9. Which underlay upgrades to which, set in Settings,
 * Business rules (e.g. Standard to Premium). Stored as one JSON setting:
 * [{ "from": <product id>, "to": <product id> }, ...]. One upgrade per
 * underlay. No imports, so the web can share it.
 * ------------------------------------------------------------------------- */

export const UNDERLAY_UPGRADES_KEY = "underlay_upgrades";

export type UpgradePair = { from: number; to: number };

/** The saved pairs, cleaned: whole ids, never to itself, the first pair for an underlay wins. */
export function parsePairs(json: string | null | undefined): UpgradePair[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: UpgradePair[] = [];
  const seen = new Set<number>();
  for (const r of raw) {
    const from = Number((r as { from?: unknown })?.from);
    const to = Number((r as { to?: unknown })?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0 || from === to || seen.has(from)) continue;
    seen.add(from);
    out.push({ from, to });
  }
  return out;
}
