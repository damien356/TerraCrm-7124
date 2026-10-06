import { FLOOR_CATEGORIES } from "./bundleCatalog";

/**
 * The pre-send check. Plain rules in code, no AI, so the same quote always
 * gets the same answer and the agent can explain it without inventing any.
 *
 *  stop  should not go out like this
 *  warn  worth a look, often fine
 *  info  for the record
 *
 * Cost and markup checks only run when the person can see costs. Their
 * wording never names a cost figure either way.
 */

export type CheckLevel = "stop" | "warn" | "info";
export type CheckItem = { level: CheckLevel; code: string; message: string; itemIds: number[] };

export type CheckLine = {
  id: number;
  kind: string;
  lineType: string;
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  listUnitPrice: number | null;
  unitCost: number | null;
  productId: number | null;
  productCategory: string | null;
  /** What the price book sells this product at today. Null for non product lines. */
  liveSell: number | null;
  flagged: boolean;
  flagReason: string | null;
};

export type CheckInput = {
  hasCustomer: boolean;
  isCompany: boolean;
  hasSupervisor: boolean;
  notes: string | null;
  lines: CheckLine[];
  bundles: { title: string; wording: string; stale: boolean }[];
  discountPct: number;
  discountLimit: number;
  discountApprovedPct: number;
  isAdmin: boolean;
  canSeeCosts: boolean;
};

const money = (n: number) => `$${n.toFixed(2)}`;
const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57).trim()}...` : s);
const isFloor = (c: string | null) => !!c && (FLOOR_CATEGORIES as readonly string[]).includes(c);

const REMOVAL_LINE = /\b(?:uplift|removal|remove|disposal|dispose|rip(?:ping)?[ -]?up|strip(?:ping)? out|skip bin|tip run)\b/i;
const PREP_LINE = /\b(?:levell?ing|self[ -]?level\w*|grind(?:ing)?|screed\w*|moisture barrier|floor prep\w*|preparation|furniture)\b/i;
const STAIR_WORDS = /\b(?:stairs?|stairway|staircase|steps?|winders?|landings?|treads?|nosings?)\b/i;
const EXISTING_FLOOR =
  /\b(?:existing|old|current)\s+(?:carpet|floor\w*|tiles?|vinyl|lino|timber|laminate|boards?|underlay)\b|\b(?:uplift|rip(?:ping)?[ -]?up|pull(?:ing)? up|take up|remove)\b/i;
const NO_UNDERLAY = /\b(?:direct\s*stick|glue[ -]?down|no underlay|underlay (?:not required|by others|supplied by)|own underlay)\b/i;
const ZERO_OK = /\b(?:credit|discount|no charge|n\/c|free|included|allowance)\b/i;

function isCarpet(l: CheckLine) {
  if (l.productCategory === "carpet") return true;
  if (l.productCategory) return false;
  return /\b(?:carpet|broadloom)\b/i.test(l.description) && !/carpet\s*tile/i.test(l.description) && !REMOVAL_LINE.test(l.description);
}
const isUnderlay = (l: CheckLine) =>
  l.productCategory === "underlay" || (/\bunderlay\b/i.test(l.description) && !REMOVAL_LINE.test(l.description));
const isRemoval = (l: CheckLine) => l.kind === "removal" || REMOVAL_LINE.test(l.description);
const isPrep = (l: CheckLine) => l.kind === "prep" || PREP_LINE.test(l.description);
/** Labour that lays a floor, not labour that takes one up or gets the slab ready. */
const isInstallLabour = (l: CheckLine) =>
  (l.lineType === "labour" || l.kind === "labour" || l.productCategory === "labour") && !isRemoval(l) && !isPrep(l);

export function checkQuote(input: CheckInput): { ok: boolean; items: CheckItem[] } {
  const out: CheckItem[] = [];
  const add = (level: CheckLevel, code: string, message: string, itemIds: number[] = []) =>
    out.push({ level, code, message, itemIds });
  const lines = input.lines;

  if (!lines.length) {
    add("stop", "no_lines", "There are no lines on this quote yet.");
    return { ok: false, items: out };
  }
  if (!input.hasCustomer) add("stop", "no_customer", "No customer on the quote.");
  if (input.isCompany && !input.hasSupervisor) add("stop", "no_supervisor", "Company quote with no supervisor picked.");

  for (const l of lines.filter((x) => x.flagged)) {
    add("stop", "flagged", `Needs checking: ${short(l.description)}.${l.flagReason ? ` ${l.flagReason}` : ""}`, [l.id]);
  }
  for (const l of lines.filter((x) => !x.flagged && x.qty > 0 && x.unitPrice <= 0 && !ZERO_OK.test(x.description))) {
    add("stop", "zero_price", `${short(l.description)} is priced at $0.`, [l.id]);
  }

  const text = [input.notes ?? "", ...lines.map((l) => l.description)].join("\n");

  // Underlay
  const carpet = lines.filter(isCarpet);
  const underlay = lines.filter(isUnderlay);
  if (carpet.length && !underlay.length && !NO_UNDERLAY.test(text)) {
    add("warn", "no_underlay", "Carpet with no underlay line. Fine if it is direct stick or the client supplies it.", carpet.map((l) => l.id));
  }
  if (carpet.length && underlay.length) {
    const carpetM2 = carpet.filter((l) => l.unit === "m2" && l.lineType !== "labour").reduce((s, l) => s + l.qty, 0);
    const underlayM2 = underlay.filter((l) => l.unit === "m2").reduce((s, l) => s + l.qty, 0);
    if (carpetM2 > 0 && underlayM2 > 0 && underlayM2 < carpetM2 * 0.9) {
      add("warn", "underlay_short", "There is less underlay than carpet. Check the underlay quantity.", underlay.map((l) => l.id));
    }
  }

  // Install labour
  const floors = lines.filter((l) => isFloor(l.productCategory) && l.lineType !== "labour");
  if (floors.length && !lines.some(isInstallLabour)) {
    add("warn", "no_labour", "There is flooring on the quote but no installation labour.", floors.map((l) => l.id));
  }

  // Stairs
  const stairLabour = lines.some((l) => isInstallLabour(l) && STAIR_WORDS.test(l.description));
  if (STAIR_WORDS.test(text) && !stairLabour) {
    add("warn", "no_stair_labour", "Stairs are mentioned but there is no stair labour line.");
  }

  // Removal
  const hasRemoval = lines.some(isRemoval);
  if (!hasRemoval && EXISTING_FLOOR.test(input.notes ?? "")) {
    add("warn", "no_removal", "The notes mention existing flooring but there is no removal or disposal line.");
  } else if (!hasRemoval && floors.length) {
    add("info", "no_removal_info", "No removal or disposal line. Fine if the floor is bare.");
  }

  // Price book
  for (const l of lines) {
    if (l.productId == null || l.liveSell == null || l.liveSell <= 0) continue;
    if (Math.abs(l.unitPrice - l.liveSell) < 0.005) continue;
    if (l.listUnitPrice != null) {
      const pct = Math.round(((l.listUnitPrice - l.unitPrice) / l.listUnitPrice) * 100);
      if (pct > 0) add("warn", "discounted", `${short(l.description)} is ${pct}% under the price book.`, [l.id]);
    } else {
      add(
        "warn",
        "price_moved",
        `${short(l.description)}: the price book now sells it at ${money(l.liveSell)}, this line has ${money(l.unitPrice)}. Quotes are never repriced on their own.`,
        [l.id],
      );
    }
  }
  if (!input.isAdmin && input.discountPct > input.discountLimit && input.discountPct > input.discountApprovedPct) {
    add(
      "stop",
      "discount_limit",
      `The quote is discounted ${input.discountPct}%. Office can go up to ${input.discountLimit}%. An Admin needs to approve it.`,
    );
  }

  // Margin. Only for people who can see costs, and never with the cost figure in the words.
  if (input.canSeeCosts) {
    for (const l of lines) {
      if (l.unitCost == null || l.unitCost <= 0 || l.qty <= 0) continue;
      if (l.unitPrice < l.unitCost) add("stop", "below_cost", `${short(l.description)} sells below cost.`, [l.id]);
      else if ((l.unitPrice - l.unitCost) / l.unitCost < 0.15 && !isRemoval(l)) {
        add("warn", "thin_margin", `${short(l.description)} has under 15% markup.`, [l.id]);
      }
    }
    const noCost = lines.filter((l) => (l.productId != null || l.lineType === "labour") && l.unitCost == null && l.unitPrice > 0);
    if (noCost.length) {
      add("info", "no_cost", `${noCost.length} line${noCost.length === 1 ? " has" : "s have"} no cost, so the margin can't be checked.`, noCost.map((l) => l.id));
    }
  }

  // What the client reads
  for (const b of input.bundles) {
    if (!b.wording.trim()) add("warn", "no_wording", `No wording on "${b.title}". The client would see the title only.`);
    else if (b.stale) add("warn", "stale_wording", `The wording on "${b.title}" was written for different lines.`);
  }

  const rank: Record<CheckLevel, number> = { stop: 0, warn: 1, info: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level]);
  return { ok: !out.some((i) => i.level === "stop"), items: out };
}
