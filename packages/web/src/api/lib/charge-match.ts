/* ---------------------------------------------------------------------------
 * READING THE EXTRA CHARGES ON A SUPPLIER INVOICE (Karndean CI155812, 6 Nov).
 *
 * One place that decides, for every line on an invoice, what it is:
 *   goods     a product
 *   charges   fuel, levies, packing and other charges on top of the rate
 *   freight   handling, freight and delivery
 * and which saved PO line and which supplier charge it is the same thing as.
 *
 * The PO comparison and the price checks both read this, so the two sides of
 * a comparison are always grouped the same way. Pure: no database here.
 *
 * Rules (Damien's brief, 6 Nov 2026):
 *  - Every invoice line is kept as printed and counted once.
 *  - A charge is matched on what it is and what it is charged per (its name or
 *    the supplier's own wording for it, and its basis), never on the amount.
 *  - A matched charge at a different price is a variance, not a new charge.
 *  - The invoice is compared with the PO lines that were saved when the PO
 *    went out, not with today's price list.
 *  - A line that could be two different charges is shown for review, never
 *    guessed.
 * ------------------------------------------------------------------------- */

export type InvLine = { description: string; qty: number | null; unit: string | null; unitPriceExGst: number | null; totalExGst: number | null };
export type PoLine = {
  id: number;
  kind: string;
  description: string;
  qty: number;
  unit: string;
  unitCostExGst: number;
  totalExGst: number;
  productId: number | null;
  sortOrder?: number;
};
export type ChargeRule = {
  id: number;
  name: string;
  invoiceNames?: string | null;
  kind: string;
  basis: string;
  amount: number | null;
  percent: number | null;
  amountIncludesGst: boolean;
  active?: boolean;
};

export type Group = "goods" | "charges" | "freight";

export const r2 = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number) => `\u0024${Math.abs(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const squash = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** A charge on the invoice is the same as the PO's when they are within a few cents. */
export const LINE_SAME = 0.05;
/** An increase on one line bigger than this makes the invoice "different", even when the total is under. */
export const LINE_INCREASE_FLAG = 1;

export const FREIGHT_RX = /freight|deliver(y|ed)?\b|cartage|transport|crane|courier|shipping/i;
export const CHARGE_RX =
  /surcharge|fuel|levy|broken\s*pack|part\s*(pack|roll)|job\s*lot|bal(e|ing)|cut(ting)?\s*fee|handling|\bfee\b|\bcharge\b|freight|deliver(y|ed)?\b|cartage|crane|courier/i;
/** A subtotal or total the reader picked up as a line. It is never a charge of its own. */
const TOTAL_RX = /^\s*(sub\s*-?\s*total|total|invoice\s*total|total\s*(ex|inc|excl?|incl?)\b|gst\b|balance|amount\s*due|carried\s*forward|brought\s*forward)/i;
const RULE_NOISE = new Set(["charge", "charges", "fee", "fees", "the", "of", "per", "and", "a", "on", "to", "for"]);

/** Supplier charge kinds that are freight. Same as the PO side (pricing FREIGHT_KINDS). */
export const FREIGHT_KINDS = new Set(["delivery"]);

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9.%]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 1 && !RULE_NOISE.has(w)),
  );

/** Share of the Ops name's words that are on the invoice line. */
export function overlap(opsName: string, line: string) {
  const want = [...words(opsName)];
  if (!want.length) return 0;
  const have = words(line);
  return want.filter((w) => have.has(w)).length / want.length;
}

/** The names a charge goes by: its own, then the supplier's invoice wording. */
export function ruleNames(r: Pick<ChargeRule, "name" | "invoiceNames">) {
  return [r.name, ...(r.invoiceNames ?? "").split(/[,;\n|]/)].map((s) => s.trim()).filter(Boolean);
}

/**
 * How sure we are a printed description is this name. Case, spaces and
 * punctuation never count. 1 = the same words. 0.9 = one is a shortening of
 * the other ("FUELSURCH" and "Fuel Surcharge"). Below that, shared words.
 */
export function nameScore(name: string, text: string) {
  const a = squash(name);
  const b = squash(text);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a))) return 0.9;
  return overlap(name, text) * 0.8;
}

export function normUnit(u: string | null | undefined) {
  const s = (u ?? "").toLowerCase().replace(/[^a-z0-9²]/g, "");
  if (!s) return null;
  if (/^(m2|sqm|m²|sqm2|msq)$/.test(s)) return "m2";
  if (/^(lm|lin|linm|mtr|metre|meter|lmtr)$/.test(s)) return "lm";
  if (/^(ea|each|pc|pce|pcs|no|unit|item)$/.test(s)) return "each";
  if (/^(box|bx|ctn|carton|pack|pk|pkt)$/.test(s)) return "box";
  if (/^(roll|rl)$/.test(s)) return "roll";
  if (/^(order|ord|flat|lot)$/.test(s)) return "order";
  if (/^(pallet|plt|pal)$/.test(s)) return "pallet";
  return s;
}

export const lineTotal = (l: InvLine) => (l.totalExGst ?? (l.qty != null && l.unitPriceExGst != null ? l.qty * l.unitPriceExGst : 0)) || 0;
export const lineRate = (l: InvLine) => l.unitPriceExGst ?? (l.qty ? lineTotal(l) / l.qty : lineTotal(l));
export const ruleAmountEx = (r: ChargeRule) => (r.amountIncludesGst ? (r.amount ?? 0) / 1.1 : (r.amount ?? 0));

const FLAT = new Set(["order", "shipment"]);
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.001);

/**
 * Does the way this line is charged fit a basis ("m2", "order", ...)?
 * A line with no unit printed fits a per-unit basis when its quantity is the
 * goods quantity in that unit, and a flat basis when its quantity is 1.
 */
export function basisFits(basis: string, l: InvLine, goodsQty: Map<string, number>) {
  if (basis === "percent_of_order" || basis === "%") return true;
  const u = normUnit(l.unit);
  if (FLAT.has(basis)) return u ? u === "order" || ((u === "each" || u === "shipment") && (l.qty ?? 1) === 1) : l.qty == null || l.qty === 1;
  if (u && u !== "each") return u === basis;
  if (l.qty == null) return false;
  const g = goodsQty.get(basis);
  if (g != null) return near(l.qty, g);
  // No goods in that unit to check against: a quantity above 1 is at least per-unit.
  return l.qty !== 1 || basis === "pallet" || basis === "roll" || basis === "box";
}

export type Row = {
  key: string;
  group: Group;
  /** What Ops calls it: the charge's current name, or the PO line, or the invoice wording. */
  label: string;
  ruleId: number | null;
  invoice: { lines: string[]; qty: number | null; unit: string | null; rate: number | null; total: number } | null;
  po: { lineId: number; description: string; qty: number; unit: string; rate: number; total: number } | null;
  /** Invoice less PO, ex GST. Positive = billed more than the PO allowed. */
  diff: number;
  status: "match" | "variance" | "not_on_po" | "not_billed" | "review";
  /** Plain words, one sentence. */
  note: string;
  /** For a review: the charges it could be. */
  candidates: string[];
};

export type Classified = {
  line: InvLine;
  group: Group;
  rule: ChargeRule | null;
  /** Charges it could be, when it could be more than one. */
  ambiguous: ChargeRule[];
  /** Ignored as a subtotal or total, never counted. */
  skipped: boolean;
};

type Opts = {
  /** Product codes by product id, to tie a goods line to its PO line. */
  skuByProductId?: Map<number, string>;
};

/** Sort every invoice line into goods, charges or freight, and name the charge it is. */
export function classifyLines(lines: InvLine[], rules: ChargeRule[], poLines: PoLine[] = []): Classified[] {
  const live = rules.filter((r) => r.active !== false && !/\bnot used\b/i.test(r.name));
  const poExtras = poLines.filter((p) => p.kind !== "goods");
  // Goods quantity by unit, from the lines that are plainly goods (no charge words, a unit printed or a big quantity).
  const goodsQty = new Map<string, number>();
  for (const l of lines) {
    if (CHARGE_RX.test(l.description) || TOTAL_RX.test(l.description)) continue;
    const u = normUnit(l.unit);
    if (!u || l.qty == null) continue;
    goodsQty.set(u, r2((goodsQty.get(u) ?? 0) + l.qty));
  }
  for (const p of poLines) if (p.kind === "goods" && !goodsQty.has(p.unit)) goodsQty.set(p.unit, p.qty);

  return lines.map((l): Classified => {
    if (TOTAL_RX.test(l.description)) return { line: l, group: "charges", rule: null, ambiguous: [], skipped: true };
    const scored = live
      .map((r) => {
        const best = Math.max(...ruleNames(r).map((n) => nameScore(n, l.description)));
        const bonus = r.kind === "fuel" && /fuel/i.test(l.description) ? 0.3 : 0;
        return { r, s: Math.min(1, best + bonus), fits: basisFits(r.basis, l, goodsQty) };
      })
      .filter((x) => x.s >= 0.6)
      .sort((a, b) => b.s - a.s);
    const fitting = scored.filter((x) => x.fits);
    const top = fitting[0];
    if (top) {
      const tied = fitting.filter((x) => x.r.id !== top.r.id && top.s - x.s < 0.05).map((x) => x.r);
      const group: Group = FREIGHT_KINDS.has(top.r.kind) ? "freight" : "charges";
      if (tied.length) return { line: l, group, rule: null, ambiguous: [top.r, ...tied], skipped: false };
      return { line: l, group, rule: top.r, ambiguous: [], skipped: false };
    }
    // Looks like a charge Ops knows but is charged a different way: a person decides.
    if (scored.length) return { line: l, group: FREIGHT_KINDS.has(scored[0]!.r.kind) ? "freight" : "charges", rule: null, ambiguous: scored.map((x) => x.r), skipped: false };
    // A PO charge line by name, when no supplier charge in Ops is called that.
    const onPo = poExtras.some((p) => nameScore(p.description, l.description) >= 0.6);
    if (FREIGHT_RX.test(l.description)) return { line: l, group: "freight", rule: null, ambiguous: [], skipped: false };
    if (onPo || CHARGE_RX.test(l.description)) {
      const po = poExtras.find((p) => nameScore(p.description, l.description) >= 0.6);
      return { line: l, group: po?.kind === "freight" ? "freight" : "charges", rule: null, ambiguous: [], skipped: false };
    }
    return { line: l, group: "goods", rule: null, ambiguous: [], skipped: false };
  });
}

/** The supplier charge a saved PO line was raised from, by its name then or now. */
export function ruleForPoLine(p: PoLine, rules: ChargeRule[]) {
  const hits = rules
    .map((r) => ({ r, s: Math.max(...ruleNames(r).map((n) => nameScore(n, p.description))) }))
    .filter((x) => x.s >= 0.9)
    .sort((a, b) => b.s - a.s);
  if (!hits.length) return null;
  if (hits.length > 1 && hits[0]!.s === hits[1]!.s) return null;
  return hits[0]!.r;
}

/** "Fuel Surcharge" reads "fuel surcharge" mid-sentence. "Resiloop recycling levy" keeps its capital. */
export function midSentence(name: string) {
  // "Handling / Freight" is a label, so it keeps its capitals.
  if (/[/&]/.test(name)) return name;
  const ws = name.split(/\s+/).filter((w) => /[a-z]/i.test(w) && !/^[A-Z0-9]{2,}$/.test(w));
  const title = ws.length > 0 && ws.every((w) => /^[A-Z][a-z]/.test(w));
  return title ? name.replace(/\b([A-Z])([a-z])/g, (_m, a: string, b: string) => a.toLowerCase() + b) : name;
}
const capFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const listAnd = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const unitWord = (u: string | null) => (u === "order" || u === "shipment" ? "an order" : u ? `a ${u}` : "each");
const qtyText = (q: number | null, u: string | null) => (q == null ? "" : `${Number(q.toFixed(3))}${u ? ` ${u}` : ""}`);

export type Comparison = {
  rows: Row[];
  /** Every invoice line as sorted, in invoice order. */
  classified: Classified[];
  invoice: { goods: number; charges: number; freight: number; extras: number; total: number; linesTotal: number };
  po: { number: string; goods: number; charges: number; freight: number; total: number } | null;
  /** Invoice total less PO total, ex GST. */
  diff: number;
  /** A line billed more than the PO allowed, by more than a dollar. A lower total never hides it. */
  hasIncrease: boolean;
  /** The lines do not add up to the invoice total. */
  linesDisagree: boolean;
  /** One paragraph, plain words, for the match note. */
  summary: string;
};

/**
 * The invoice against the saved PO lines, line by line. With no PO, the rows
 * are just the invoice sorted into groups.
 */
export function compareToPo(
  inv: { totalExGst: number; lines: InvLine[] },
  po: { number: string; totalExGst: number; lines: PoLine[] } | null,
  rules: ChargeRule[],
  opts: Opts = {},
): Comparison {
  const poLines = po?.lines ?? [];
  const classified = classifyLines(inv.lines, rules, poLines);
  const counted = classified.filter((c) => !c.skipped);
  const rows: Row[] = [];
  const usedPo = new Set<number>();
  const poRule = new Map<number, ChargeRule | null>(poLines.filter((p) => p.kind !== "goods").map((p) => [p.id, ruleForPoLine(p, rules)]));

  const invPart = (c: Classified) => ({
    lines: [c.line.description],
    qty: c.line.qty,
    unit: normUnit(c.line.unit) ?? (c.rule && !FLAT.has(c.rule.basis) && c.rule.basis !== "percent_of_order" ? c.rule.basis : c.rule ? "order" : null),
    rate: c.line.unitPriceExGst ?? (c.line.qty ? r2(lineTotal(c.line) / c.line.qty) : null),
    total: r2(lineTotal(c.line)),
  });
  const poPart = (p: PoLine) => ({ lineId: p.id, description: p.description, qty: p.qty, unit: p.unit, rate: p.unitCostExGst, total: p.totalExGst });

  /* goods: product code first, then words, then one line against one line */
  const poGoods = poLines.filter((p) => p.kind === "goods");
  const invGoods = counted.filter((c) => c.group === "goods");
  for (const c of invGoods) {
    const desc = squash(c.line.description);
    const cands = poGoods
      .filter((p) => !usedPo.has(p.id))
      .map((p) => {
        const sku = squash(p.productId ? opts.skuByProductId?.get(p.productId) : "");
        return { p, s: sku.length >= 5 && desc.includes(sku) ? 2 : overlap(p.description, c.line.description) };
      })
      .sort((a, b) => b.s - a.s);
    const pick = cands[0] && (cands[0].s >= 0.6 || (invGoods.length === 1 && poGoods.length === 1)) ? cands[0].p : null;
    if (pick) usedPo.add(pick.id);
    rows.push(pairRow(`g:${rows.length}`, "goods", pick?.description ?? c.line.description, null, invPart(c), pick ? poPart(pick) : null));
  }

  /* charges and freight: the same charge on both sides, by identity then by name */
  for (const c of counted.filter((x) => x.group !== "goods")) {
    if (!c.rule && c.ambiguous.length) {
      rows.push({
        key: `r:${rows.length}`,
        group: c.group,
        label: c.line.description,
        ruleId: null,
        invoice: invPart(c),
        po: null,
        diff: r2(lineTotal(c.line)),
        status: "review",
        note: `"${c.line.description}" ${money(lineTotal(c.line))} could be ${listAnd(c.ambiguous.map((r) => r.name)).replace(/ and ([^,]*)$/, " or $1")}. Check which charge it is.`,
        candidates: c.ambiguous.map((r) => r.name),
      });
      continue;
    }
    const free = poLines.filter((p) => p.kind !== "goods" && !usedPo.has(p.id));
    let p: PoLine | undefined;
    if (c.rule) p = free.find((x) => poRule.get(x.id)?.id === c.rule!.id);
    if (!p) {
      const byName = free
        .filter((x) => !poRule.get(x.id) || !c.rule)
        .map((x) => ({ x, s: nameScore(x.description, c.line.description) }))
        .filter((y) => y.s >= 0.6)
        .sort((a, b) => b.s - a.s);
      p = byName[0]?.x;
    }
    if (p) usedPo.add(p.id);
    rows.push(pairRow(`c:${rows.length}`, c.group, c.rule?.name ?? (p ? (poRule.get(p.id)?.name ?? p.description) : c.line.description), c.rule?.id ?? null, invPart(c), p ? poPart(p) : null));
  }

  /* on the PO, not on the invoice */
  for (const p of poLines.filter((x) => !usedPo.has(x.id))) {
    const rule = p.kind === "goods" ? null : (poRule.get(p.id) ?? null);
    const group: Group = p.kind === "goods" ? "goods" : p.kind === "freight" || (rule && FREIGHT_KINDS.has(rule.kind)) ? "freight" : "charges";
    rows.push({
      key: `p:${p.id}`,
      group,
      label: rule?.name ?? p.description,
      ruleId: rule?.id ?? null,
      invoice: null,
      po: poPart(p),
      diff: r2(-p.totalExGst),
      status: "not_billed",
      note: `${rule?.name ?? p.description} (${money(p.totalExGst)} on the PO) is not on this invoice.`,
      candidates: [],
    });
  }

  const sum = (g: Group) => r2(counted.filter((c) => c.group === g).reduce((a, c) => a + lineTotal(c.line), 0));
  const goods = sum("goods");
  const charges = sum("charges");
  const freight = sum("freight");
  const linesTotal = r2(goods + charges + freight);
  const total = r2(inv.totalExGst);
  const linesDisagree = counted.length > 0 && Math.abs(linesTotal - total) > LINE_SAME;
  const poSum = (f: (p: PoLine) => boolean) => r2(poLines.filter(f).reduce((a, p) => a + p.totalExGst, 0));
  const poOut = po
    ? {
        number: po.number,
        goods: poSum((p) => p.kind === "goods"),
        charges: poSum((p) => p.kind !== "goods" && rows.find((r) => r.po?.lineId === p.id)?.group !== "freight"),
        freight: poSum((p) => p.kind !== "goods" && rows.find((r) => r.po?.lineId === p.id)?.group === "freight"),
        total: r2(po.totalExGst),
      }
    : null;
  const diff = po ? r2(total - po.totalExGst) : 0;
  const hasIncrease = rows.some((r) => r.status !== "match" && r.diff > LINE_INCREASE_FLAG);

  return {
    rows,
    classified,
    invoice: { goods, charges, freight, extras: r2(charges + freight), total, linesTotal },
    po: poOut,
    diff,
    hasIncrease,
    linesDisagree,
    summary: po ? summarise(rows, poOut!, diff, { linesDisagree, linesTotal, total }) : "",
  };
}

function pairRow(key: string, group: Group, label: string, ruleId: number | null, inv: NonNullable<Row["invoice"]>, po: Row["po"]): Row {
  if (!po) {
    return { key, group, label, ruleId, invoice: inv, po: null, diff: inv.total, status: "not_on_po", note: `${label} ${money(inv.total)} is on the invoice but not on the PO.`, candidates: [] };
  }
  const diff = r2(inv.total - po.total);
  // To the cent: only then does the note say "matches". A few cents either way is still a match for status, but the note says what differs.
  if (Math.abs(diff) < 0.005) return { key, group, label, ruleId, invoice: inv, po, diff, status: "match", note: `${label} matches the PO.`, candidates: [] };
  const status = Math.abs(diff) <= LINE_SAME ? "match" : "variance";
  const flat = (po.unit === "order" || po.unit === "shipment" || po.qty === 1) && (inv.qty == null || inv.qty === 1);
  const more = diff > 0 ? "more" : "less";
  const per = unitWord(po.unit);
  let note: string;
  if (flat) {
    note = group === "goods" ? `${label} was billed at ${money(inv.total)} against ${money(po.total)} on the PO.` : `${label} was billed at ${money(inv.total)} against the ${money(po.total)} allowance.`;
  } else {
    const qtySame = inv.qty == null || near(inv.qty, po.qty);
    // The PO rate on the invoice's own quantity gives the invoice amount: the rate is the same, whatever the invoice prints.
    const atPoRate = inv.qty != null && Math.abs(r2(inv.qty * po.rate) - inv.total) <= 0.011;
    const both = `${money(inv.total)} against ${money(po.total)}, ${money(diff)} ${more}`;
    if (!qtySame && atPoRate) {
      note = `${label} was billed at the PO rate of ${money(po.rate)} ${per} on ${qtyText(inv.qty, po.unit)} against ${qtyText(po.qty, po.unit)} on the PO: ${both}.`;
    } else if (!qtySame) {
      note = `${label} was billed on ${qtyText(inv.qty, po.unit)} at ${money(inv.total / inv.qty!)} ${per} (${money(inv.total)}) against ${qtyText(po.qty, po.unit)} at ${money(po.rate)} ${per} on the PO (${money(po.total)}), ${money(diff)} ${more}.`;
    } else if (atPoRate) {
      note = `${label} was billed at the PO rate of ${money(po.rate)} ${per} on the same quantity: ${both}.`;
    } else {
      note = `${label} was billed at ${money(inv.rate ?? 0)} ${per} (${money(inv.total)}) against ${money(po.rate)} ${per} on the PO (${money(po.total)}), ${money(diff)} ${more}.`;
    }
    // The printed unit price does not give the printed amount. Say which one the amount follows, so nobody reads the wrong rate.
    if (atPoRate && inv.qty != null && inv.rate != null && Math.abs(r2(inv.qty * inv.rate) - inv.total) > 0.011) {
      note += ` The invoice prints ${money(inv.rate)} ${per} on this line, but its amount is ${qtyText(inv.qty, po.unit)} at ${money(po.rate)} (at ${money(inv.rate)} it would be ${money(r2(inv.qty * inv.rate))}).`;
    }
  }
  return { key, group, label, ruleId, invoice: inv, po, diff, status, note, candidates: [] };
}

function summarise(rows: Row[], po: NonNullable<Comparison["po"]>, diff: number, t: { linesDisagree: boolean; linesTotal: number; total: number }) {
  const out: string[] = [];
  out.push(Math.abs(diff) < 0.005 ? `Invoice agrees with ${po.number}.` : `Invoice is ${money(diff)} ex GST ${diff < 0 ? "below" : "above"} ${po.number}.`);
  // Increases first, so a lower total never buries one.
  // Then the decreases, largest first. Lines a few cents out are named too, never folded into "match".
  const notable = rows
    .filter((r) => r.status !== "match" || Math.abs(r.diff) >= 0.005)
    .sort((a, b) => (a.diff > 0 || b.diff > 0 ? b.diff - a.diff : a.diff - b.diff));
  for (const r of notable) out.push(r.note);
  const goodsOk = rows.filter((r) => r.group === "goods");
  const matched: string[] = [];
  const exact = (r: Row) => r.status === "match" && Math.abs(r.diff) < 0.005;
  if (goodsOk.length && goodsOk.every(exact)) matched.push(goodsOk.length === 1 ? "Product" : "Products");
  // In the PO's own order, so the sentence reads like the PO.
  const poOrder = (r: Row) => r.po?.lineId ?? Number.MAX_SAFE_INTEGER;
  for (const r of rows.filter((x) => x.group !== "goods" && exact(x)).sort((a, b) => poOrder(a) - poOrder(b))) matched.push(midSentence(r.label));
  if (matched.length) out.push(`${capFirst(listAnd(matched))} ${matched.length === 1 && matched[0] !== "Products" ? "matches" : "match"} the PO.`);
  if (t.linesDisagree) out.push(`The invoice lines add up to ${money(t.linesTotal)}, but the invoice total is ${money(t.total)} ex GST. Check the PDF.`);
  return out.join(" ");
}
