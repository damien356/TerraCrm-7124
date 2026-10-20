/* ---------------------------------------------------------------------------
 * The name side of the ABN check (notes 18.64, 18.66). Pure, no database, so
 * the installer card can run the same check on what is typed in the form
 * right now, before and after saving.
 *
 * An installer has up to three names on his card:
 * - name: the short name he goes by. Schedule, Crew, the phone and texts.
 * - fullName: his full legal name, as on his ABN.
 * - tradingName: his business name.
 * The check passes when any one of them matches the legal name or a business
 * name on the ABN, ignoring Pty Ltd, Ltd, capitals and punctuation.
 * ------------------------------------------------------------------------- */

/** Lower case, no punctuation, no Pty, Ltd, Limited or Proprietary. */
export function normName(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["pty", "ltd", "limited", "proprietary"].includes(w))
    .join(" ");
}

/** "1 May 2025" for a register date. */
export function abnDate(iso: string | null | undefined) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso ?? "";
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The names on his card that are compared with the ABN. */
export type CardNames = { name: string | null | undefined; fullName?: string | null; tradingName?: string | null };

/** Does any name on the card match the ABN. Null when there is nothing to compare yet. */
export function namesMatch(
  card: CardNames,
  abr: { legalName: string | null; entityType?: string | null; businessNames: string[] },
) {
  if (!abr.legalName) return null;
  const theirs = new Set([abr.legalName, ...abr.businessNames].map(normName).filter(Boolean));
  // A sole trader's middle names are left out of the compare.
  const parts = normName(abr.legalName).split(" ");
  if (/individual|sole trader/i.test(abr.entityType ?? "") && parts.length > 2) theirs.add(`${parts[0]} ${parts[parts.length - 1]}`);
  const ours = [card.name, card.fullName, card.tradingName].map(normName).filter(Boolean);
  return ours.some((n) => theirs.has(n));
}

export const NAME_MISMATCH =
  "Name does not match the ABN. None of his short name, full name or trading name matches the legal name or a business name.";

export type AbnState = "missing" | "unchecked" | "active" | "cancelled" | "not_found" | "invalid" | "error";

/** The tick or the warning for a checked ABN, against the names given. */
export function abnVerdict(
  v: {
    state: AbnState;
    statusFrom: string | null;
    checkError: string | null;
    legalName: string | null;
    entityType: string | null;
    businessNames: string[];
  },
  card: CardNames,
) {
  const mismatch = namesMatch(card, v) === false;
  const passes = v.state === "active" && !mismatch;
  const warning =
    v.state === "missing"
      ? "No ABN on his card."
      : v.state === "unchecked"
        ? "Not checked yet."
        : v.state === "error"
          ? `Could not check: ${v.checkError}`
          : v.state === "cancelled"
            ? `ABN cancelled${v.statusFrom ? ` from ${abnDate(v.statusFrom)}` : ""}.`
            : v.state === "not_found"
              ? "ABN not found on the register."
              : v.state === "invalid"
                ? "Not a valid ABN."
                : mismatch
                  ? NAME_MISMATCH
                  : null;
  return { passes, mismatch, warning };
}
