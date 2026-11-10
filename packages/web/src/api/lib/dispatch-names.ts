/* ---------------------------------------------------------------------------
 * Dispatch names after a split (Damien, 11 Nov 2026, job 188070). Split by
 * trade moved the hybrid and scotia onto 188070-B but 188070-A kept the name
 * "Carpet tile install + Hybrid installation + 1 more". The dispatch left
 * behind now takes the name of the work still on it, when its old name was
 * made from its work. A name the office typed is kept. Pure: the split
 * window shows the same name the server will save.
 * ------------------------------------------------------------------------- */

/** "A", "A + B", or "A + B + 2 more", the same shape the quote gives a dispatch. */
export function nameFromWork(names: string[]): string {
  const list = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  return list.length <= 2 ? list.join(" + ") : `${list.slice(0, 2).join(" + ")} + ${list.length - 2} more`;
}

/** True when the old name was made from the work lines: it names work that is moving, or ends "+ 2 more". */
export function namedFromWork(title: string, moving: string[]): boolean {
  const t = title.toLowerCase();
  if (/\+ \d+ more$/.test(t.trim())) return true;
  return moving.some((n) => n.trim() && t.includes(n.trim().toLowerCase()));
}

/**
 * The name the dispatch left behind should have, or null to keep its name.
 * A name typed in the split window wins.
 */
export function leftBehindName(title: string, moving: string[], staying: string[], typed?: string | null): string | null {
  const own = typed?.trim();
  if (own) return own === title ? null : own;
  if (!staying.length || !namedFromWork(title, moving)) return null;
  const next = nameFromWork(staying);
  return next && next !== title ? next : null;
}
