import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { isChargeLive, priceProduct, sellExGst, todayISO, type SpecialRow } from "./pricing";
import { notifyOffice } from "./notify";
import { FREIGHT_KINDS, type Row } from "./charge-match";
import { compareInvoice } from "./invoice-compare";

/* ---------------------------------------------------------------------------
 * PRICE CHECKS.
 *
 * Every supplier invoice is read line by line against the Ops price list and
 * the supplier's charge rules. A rate that differs becomes a `price_flags` row
 * for Damien. NOTHING HERE CHANGES A PRICE BY ITSELF. Approve changes that one
 * rate and logs which invoice proved it. Ignore leaves the price list alone.
 *
 * Damien's rules:
 *  - A changed standard product cost, once approved, resets the sell price
 *    with the standard chain, cost x 1.3 x 1.05 x 1.4 (`sellExGst`).
 *    Damien's call, 2 Oct 2026.
 *  - A special or clearance price on an invoice never moves the sell price.
 *    It is extra margin, so it is shown, never offered as a price list change.
 *  - Small differences are not worth his time: only over $10 on the invoice
 *    gets flagged (Damien, 2 Oct 2026).
 *  - A new flag over $50 also texts him, if a mobile is set under Settings >
 *    Email agent. One text per invoice, and only when the flag is new.
 * ------------------------------------------------------------------------- */

const r2 = (n: number) => Math.round(n * 100) / 100;
const $ = (n: number) => `\u0024${Math.abs(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lc = (s: string) => s.toLowerCase();
const squash = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Damien's line: flag anything over $10 on the invoice. Compares invoice totals, not rates. */
export const FLAG_OVER_EX_GST = 10;
/** A new flag over this also emails him straight away (item 15: email, not a text). */
export const EMAIL_OVER_EX_GST = 50;
/** The old texting setting. No longer read: price flags never text. Kept so Settings can say it is off. */
export const PRICE_SMS_KEY = "price_flag_sms_to";

export function worthFlagging(opsExGst: number, billedExGst: number) {
  return Math.abs(r2(billedExGst - opsExGst)) > FLAG_OVER_EX_GST;
}

type InvLine = { description: string; qty: number | null; unit: string | null; unitPriceExGst: number | null; totalExGst: number | null };
type Rule = typeof schema.supplierFeeRules.$inferSelect;
type Product = typeof schema.products.$inferSelect;

export type FlagChange =
  | { target: "product"; productId: number; field: "costPrice"; from: number; to: number; sellFrom: number | null; sellTo: number }
  | { target: "rule"; feeRuleId: number; field: "amount" | "percent"; from: number; to: number }
  | { target: "rule"; feeRuleId: number; field: "percentBase"; from: string; to: string };

export type FlagDraft = {
  kind: string;
  key: string;
  productId: number | null;
  feeRuleId: number | null;
  lineText: string;
  opsValue: number | null;
  invoiceValue: number | null;
  unit: string;
  qty: number | null;
  impactExGst: number;
  title: string;
  detail: string;
  change: FlagChange | null;
};

const SPECIAL_RX = /special|clearance|promo|run[\s-]*out|discount|\bdeal\b|sale\b|ex[\s-]*stock\s*offer/i;
const RULE_NOISE = new Set(["charge", "charges", "fee", "fees", "the", "of", "per", "and", "a", "on", "to", "for"]);

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9.%]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 1 && !RULE_NOISE.has(w)),
  );

/** Share of the Ops name's words that are on the invoice line. */
function overlap(opsName: string, line: string) {
  const want = [...words(opsName)];
  if (!want.length) return 0;
  const have = words(line);
  return want.filter((w) => have.has(w)).length / want.length;
}

function normUnit(u: string | null | undefined) {
  const s = (u ?? "").toLowerCase().replace(/[^a-z0-9²]/g, "");
  if (!s) return null;
  if (/^(m2|sqm|m²|sqm2|msq)$/.test(s)) return "m2";
  if (/^(lm|lin|linm|mtr|metre|meter|lmtr)$/.test(s)) return "lm";
  if (/^(ea|each|pc|pce|pcs|no|unit|item)$/.test(s)) return "each";
  if (/^(box|bx|ctn|carton|pack|pk|pkt)$/.test(s)) return "box";
  if (/^(roll|rl)$/.test(s)) return "roll";
  return s;
}

const lineTotal = (l: InvLine) => (l.totalExGst ?? (l.qty != null && l.unitPriceExGst != null ? l.qty * l.unitPriceExGst : 0)) || 0;
const lineRate = (l: InvLine) => l.unitPriceExGst ?? (l.qty ? lineTotal(l) / l.qty : lineTotal(l));
const ruleAmountEx = (r: Rule) => (r.amountIncludesGst ? (r.amount ?? 0) / 1.1 : (r.amount ?? 0));

/**
 * Work out every flag for one invoice. Pure reading, writes nothing.
 * Exported for the tests and for the "check again" button.
 */
export async function draftFlags(invoiceId: number): Promise<FlagDraft[]> {
  const [inv] = await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, invoiceId));
  if (!inv || inv.docType === "credit" || !inv.supplierId) return [];
  const [supplier] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, inv.supplierId));
  if (!supplier) return [];
  // Sorted once, in charge-match.ts, the same way the PO comparison and the invoice panel read it.
  const cmp = await compareInvoice(inv);
  if (!cmp || !cmp.hasLines) return [];

  const on = inv.invoiceDate ?? todayISO();
  const who = supplier.name;
  const ref = `invoice ${inv.invoiceNumber}`;
  const Ref = `Invoice ${inv.invoiceNumber}`;
  const whose = /'s$/i.test(who) ? who : /s$/i.test(who) ? `${who}'` : `${who}'s`;
  const rules = await db
    .select()
    .from(schema.supplierFeeRules)
    .where(and(eq(schema.supplierFeeRules.supplierId, supplier.id), eq(schema.supplierFeeRules.active, true)));
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const [po] = cmp.poId ? await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, cmp.poId)) : [];
  const poLines = po ? await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, po.id)) : [];

  const goods: InvLine[] = cmp.classified.filter((c) => !c.skipped && c.group === "goods").map((c) => c.line);
  const flags: FlagDraft[] = [];

  /* -------------------------------- goods -------------------------------- */
  const poGoods = poLines.filter((l) => l.kind === "goods" && l.productId);
  const productIds = new Set(poGoods.map((l) => l.productId!));
  // No PO: a product code printed on the line is the only safe way to tie it.
  let bySku: Product[] = [];
  if (!po) {
    bySku = (await db.select().from(schema.products).where(eq(schema.products.supplierId, supplier.id))).filter((p) => squash(p.sku).length >= 5);
    for (const p of bySku) productIds.add(p.id);
  }
  const products = productIds.size ? await db.select().from(schema.products).where(inArray(schema.products.id, [...productIds])) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const specialRows = productIds.size ? await db.select().from(schema.productSpecials).where(inArray(schema.productSpecials.productId, [...productIds])) : [];
  const specials = new Map<number, SpecialRow[]>();
  for (const s of specialRows) specials.set(s.productId, [...(specials.get(s.productId) ?? []), s]);

  // The supplier's own name is on every product of theirs and almost never on an invoice line.
  const productText = (p: Product) => [squash(p.brand) === squash(who) ? "" : p.brand, p.range, p.colour, p.size].filter(Boolean).join(" ");
  const usedPo = new Set<number>();
  for (const l of goods) {
    const desc = squash(l.description);
    let p: Product | undefined;
    if (po) {
      const cands = poGoods
        .filter((pl) => !usedPo.has(pl.id))
        .map((pl) => {
          const prod = byId.get(pl.productId!);
          const sku = squash(prod?.sku);
          const s = sku.length >= 5 && desc.includes(sku) ? 2 : Math.max(overlap(pl.description, l.description), prod ? overlap(productText(prod), l.description) : 0);
          return { pl, prod, s };
        })
        .sort((a, b) => b.s - a.s);
      const pick = cands[0] && (cands[0].s >= 0.6 || (goods.length === 1 && poGoods.length === 1)) ? cands[0] : null;
      if (pick?.prod) {
        usedPo.add(pick.pl.id);
        p = pick.prod;
      }
    } else {
      const hits = bySku.filter((x) => desc.includes(squash(x.sku)));
      if (hits.length === 1) p = byId.get(hits[0]!.id);
    }
    if (!p || p.costPrice === null || p.priceOnApplication) continue;

    const unit = normUnit(l.unit) ?? p.unit;
    if (unit !== p.unit) continue; // a box price against a m2 price says nothing
    const qty = l.qty ?? 1;
    const billed = r2(lineRate(l));
    const priced = priceProduct(p, specials.get(p.id) ?? [], on);
    const standard = p.costPrice;
    const live = priced.costExGst ?? standard;
    const key = `${invoiceId}:p:${p.id}`;
    const base = { key, productId: p.id, feeRuleId: null, lineText: l.description, invoiceValue: billed, unit: p.unit, qty };
    const name = productText(p);

    if (priced.onSpecial) {
      if (!worthFlagging(live * qty, billed * qty)) continue;
      const missed = !worthFlagging(standard * qty, billed * qty);
      flags.push({
        ...base,
        kind: missed ? "special_missed" : "product_other",
        opsValue: live,
        impactExGst: r2((billed - live) * qty),
        title: missed ? `${who} billed full price on ${name}` : `${who} billed ${name} at ${$(billed)}`,
        detail: missed
          ? `${Ref} bills ${$(billed)} a ${p.unit}, the standard price. Ops has ${priced.special?.label ?? "a special"} at ${$(live)} running on ${on}. Ask ${who} for a credit of ${$((billed - live) * qty)}.`
          : `${Ref} bills ${$(billed)} a ${p.unit}. Ops has the special at ${$(live)} and the standard at ${$(standard)}. Check it with ${who}. Nothing is changed while a special is running.`,
        change: null,
      });
      continue;
    }
    if (!worthFlagging(standard * qty, billed * qty)) continue;
    const impact = r2((billed - standard) * qty);
    if (billed < standard && SPECIAL_RX.test(l.description)) {
      flags.push({
        ...base,
        kind: "invoice_special",
        opsValue: standard,
        impactExGst: impact,
        title: `${name} billed as a special, ${$(standard - billed)} a ${p.unit} under the price list`,
        detail: `${Ref} bills ${$(billed)} a ${p.unit} against ${$(standard)} in Ops. That is ${$(-impact)} extra margin on this invoice. Specials never move the sell price, so the price list stays as it is.`,
        change: null,
      });
      continue;
    }
    const sellTo = sellExGst(billed);
    flags.push({
      ...base,
      kind: "product_cost",
      opsValue: standard,
      impactExGst: impact,
      title: `${name}: ${who} billed ${$(billed)} a ${p.unit}, Ops has ${$(standard)}`,
      detail:
        `${billed > standard ? "Up" : "Down"} ${$(billed - standard)} a ${p.unit}, ${billed > standard ? "costing" : "saving"} ${$(impact)} on ${ref}. ` +
        `Approve sets the cost to ${$(billed)} and the sell price ${p.sellPrice !== null ? `from ${$(p.sellPrice)} ` : ""}to ${$(sellTo)} (cost x 1.3 x 1.05 x 1.4).` +
        (billed < standard ? " If this is a one-off special, press Ignore and the price list stays." : ""),
      change: { target: "product", productId: p.id, field: "costPrice", from: standard, to: billed, sellFrom: p.sellPrice, sellTo },
    });
  }

  /* ------------------------- charges and freight ------------------------- */
  // Checked against the Ops price list, the supplier's charges. What the PO
  // allowed is the match note and the invoice panel (charge-match.ts), so a
  // charge that is on the PO is never called new here, and one invoice never
  // rewrites a standing charge by itself.
  const goodsTotal = r2(goods.reduce((a, l) => a + lineTotal(l), 0));
  const goodsQty = new Map<string, number>();
  for (const l of goods) {
    const u = normUnit(l.unit);
    if (u && l.qty != null) goodsQty.set(u, r2((goodsQty.get(u) ?? 0) + l.qty));
  }
  for (const pl of poLines) if (pl.kind === "goods" && !goodsQty.has(pl.unit)) goodsQty.set(pl.unit, pl.qty);

  const extras = cmp.rows.filter((r) => r.group !== "goods" && r.invoice);
  const textOf = (row: Row) => row.invoice!.lines.join(", ");
  const isPct = (row: Row) => (row.ruleId ? ruleById.get(row.ruleId)?.basis === "percent_of_order" : /%/.test(textOf(row)));
  const per = (basis: string) => (basis === "order" || basis === "shipment" ? `an ${basis}` : `a ${basis}`);
  const gstWord = (r: Rule) => (r.amountIncludesGst ? "inc GST" : "ex GST");
  const onPo = po ? po.number : "";
  // Charges the invoice has, or might have (a line waiting for review), so none is called missing.
  const seen = new Set<number>();
  for (const row of extras) {
    if (row.ruleId) seen.add(row.ruleId);
    for (const name of row.candidates) for (const r of rules) if (r.name === name) seen.add(r.id);
  }

  for (const row of extras) {
    const il = row.invoice!;
    const text = textOf(row);
    const billed = il.total;
    const squashed = squash(text).slice(0, 40);

    // Could be two different charges: a person says which. Nothing is guessed.
    if (row.status === "review") {
      if (Math.abs(billed) < 0.5) continue;
      flags.push({
        kind: "charge_review",
        key: `${invoiceId}:r:${squashed}`,
        productId: null,
        feeRuleId: null,
        lineText: text,
        opsValue: null,
        invoiceValue: billed,
        unit: il.unit ?? "",
        qty: il.qty,
        impactExGst: 0,
        title: `Which ${who} charge is "${text}" (${$(billed)})?`,
        detail: `${row.note} Add "${text}" as an invoice name on the right charge under Suppliers, then Check again. Nothing is matched or changed until then.`,
        change: null,
      });
      continue;
    }

    // Not one of the supplier's charges in Ops.
    if (!row.ruleId) {
      if (row.po) {
        // On the PO, so it was allowed. Only the price list cannot read the wording.
        const poRule = rules.find((r) => r.name === row.label);
        flags.push({
          kind: "charge_mapping",
          key: `${invoiceId}:m:${row.po.lineId}`,
          productId: null,
          feeRuleId: poRule?.id ?? null,
          lineText: text,
          opsValue: row.po.rate,
          invoiceValue: il.rate,
          unit: row.po.unit,
          qty: il.qty,
          impactExGst: 0,
          title: `"${text}" is on ${onPo}, but Ops does not know ${whose} wording for it`,
          detail:
            `It matches "${row.po.description}" on the PO${row.status === "match" && Math.abs(row.diff) < 0.005 ? ", for the same money" : `. ${row.note}`}. ` +
            (poRule
              ? `Add "${text}" as an invoice name on ${poRule.name} under Suppliers so the price list can check it too.`
              : `No ${who} charge in Ops goes by this name, so the price list cannot check it. Add it under Suppliers if it is a standing charge.`) +
            " Nothing is changed by itself.",
          change: null,
        });
        continue;
      }
      if (Math.abs(billed) < 0.5) continue;
      flags.push({
        kind: row.group === "freight" ? "freight" : "new_charge",
        key: `${invoiceId}:l:${squashed}`,
        productId: null,
        feeRuleId: null,
        lineText: text,
        opsValue: null,
        invoiceValue: billed,
        unit: il.unit ?? "",
        qty: il.qty,
        impactExGst: billed,
        title: `${who} charged "${text}" ${$(billed)}`,
        detail:
          (po ? `${onPo} has no line for it, and Ops has no ${who} charge by this name.` : `Ops has no ${who} charge by this name.`) +
          ` If it is a standing charge, add it under Suppliers, or add "${text}" as an invoice name on the charge it is. Check it with ${who} before paying. Nothing is added by itself.`,
        change: null,
      });
      continue;
    }

    const r = ruleById.get(row.ruleId);
    if (!r) continue;
    const key = `${invoiceId}:f:${r.id}`;
    if (flags.some((f) => f.key === key)) continue; // two lines for one charge: the first one speaks for it
    const base = { key, productId: null, feeRuleId: r.id, lineText: text, invoiceValue: billed, qty: il.qty };
    const freightCharge = FREIGHT_KINDS.has(r.kind);

    if (!isChargeLive(r, on)) {
      flags.push({
        ...base,
        kind: "fee_amount",
        opsValue: 0,
        unit: r.basis,
        impactExGst: billed,
        title: `${who} still charging ${lc(r.name)}`,
        detail: `${Ref} charges ${$(billed)}. In Ops this charge ${r.effectiveFrom && r.effectiveFrom > on ? `only starts ${r.effectiveFrom}` : `ended ${r.effectiveUntil}`}. Check the dates under Suppliers.`,
        change: null,
      });
      continue;
    }

    if (r.basis === "percent_of_order") {
      const pct = r.percent ?? 0;
      const otherRows = extras.filter((o) => o !== row && o.status !== "review" && o.group === "charges" && !isPct(o));
      const others = r2(otherRows.reduce((a, o) => a + o.invoice!.total, 0));
      const onCharges = r.percentBase === "goods_and_charges";
      const opsBase = onCharges ? goodsTotal + others : goodsTotal;
      const expected = r2((opsBase * pct) / 100);
      if (!worthFlagging(expected, billed)) continue;
      const altBase = onCharges ? goodsTotal : goodsTotal + others;
      const altExpected = r2((altBase * pct) / 100);
      const impact = r2(billed - expected);
      if (others > 0 && Math.abs(altExpected - billed) <= Math.max(0.05, billed * 0.001)) {
        const to = onCharges ? "goods" : "goods_and_charges";
        const otherNames = otherRows.map((o) => o.label.toLowerCase());
        flags.push({
          ...base,
          kind: "fee_basis",
          opsValue: expected,
          unit: "%",
          impactExGst: impact,
          title: `${who} work the ${lc(r.name)} out on ${to === "goods" ? "goods only" : `goods plus the ${otherNames.join(" and the ")}`}`,
          detail:
            to === "goods_and_charges"
              ? `${pct}% of ${$(goodsTotal)} goods plus ${$(others)} ${otherNames.join(" and ")} = ${$(billed)}, which is what ${ref} charges. Ops works it on the goods only, ${$(expected)}. ${$(impact)} ${impact > 0 ? "more" : "less"} on this invoice. Approve and Ops works ${whose} ${lc(r.name)} the same way from now on.`
              : `${pct}% of ${$(goodsTotal)} goods only = ${$(billed)}, which is what ${ref} charges. Ops works it on goods and charges, ${$(expected)}. Approve and Ops goes back to goods only for ${who}.`,
          change: { target: "rule", feeRuleId: r.id, field: "percentBase", from: r.percentBase, to },
        });
        continue;
      }
      const printed = Number(/(\d+(?:\.\d+)?)\s*%/.exec(text)?.[1] ?? NaN);
      const implied = opsBase > 0 ? r2((billed / opsBase) * 100) : NaN;
      const newPct = Number.isFinite(printed) && Math.abs((opsBase * printed) / 100 - billed) <= 0.05 ? printed : implied;
      const canChange = Number.isFinite(newPct) && newPct !== pct && newPct > 0 && newPct < 50;
      flags.push({
        ...base,
        kind: "fee_percent",
        opsValue: expected,
        unit: "%",
        impactExGst: impact,
        title: `${whose} ${lc(r.name)}: ${canChange ? `${newPct}% billed, Ops has ${pct}%` : `${$(billed)} billed, Ops expects ${$(expected)}`}`,
        detail: canChange
          ? `${Ref} charges ${$(billed)} on ${$(opsBase)}, which is ${newPct}%. Ops has ${pct}% (${$(expected)}). Approve sets the ${lc(r.name)} to ${newPct}%.`
          : `${Ref} charges ${$(billed)}. ${pct}% of ${$(opsBase)} is ${$(expected)}. It does not work out as a clean percentage, so check it with ${who}.`,
        change: canChange ? { target: "rule", feeRuleId: r.id, field: "percent", from: pct, to: newPct } : null,
      });
      continue;
    }

    // A flat or per-unit charge: compare the RATE, never put the line total in its place.
    const flat = r.basis === "order" || r.basis === "shipment";
    const units = flat ? 1 : (il.qty ?? 1);
    const opsRate = r2(ruleAmountEx(r));
    const billedRate = r2(units ? billed / units : billed);
    if (!worthFlagging(opsRate * units, billed)) continue;
    const to = r.amountIncludesGst ? r2(billedRate * 1.1) : billedRate;
    const workings = units !== 1 ? `${Number(units.toFixed(3))} ${r.basis} × ${$(billedRate)} = ${$(billed)} ex GST` : `${$(billed)} ex GST`;
    const allowed = row.po ? ` ${onPo} allowed ${$(row.po.total)}.` : "";
    flags.push({
      ...base,
      kind: "fee_amount",
      opsValue: opsRate,
      invoiceValue: billedRate,
      unit: r.basis,
      impactExGst: r2(billed - opsRate * units),
      title: `${whose} ${lc(r.name)}: ${$(billedRate)} ${per(r.basis)} billed, Ops has ${$(opsRate)}`,
      detail: freightCharge
        ? // Handling and freight move with every delivery. One invoice does not show the standing charge has changed.
          `${Ref} (${on}) charges ${workings} for ${lc(r.name)}. Ops has ${$(opsRate)} ${per(r.basis)} ex GST.${allowed} One invoice does not show the standing charge has changed, so nothing is offered to change. If ${who} confirm a new rate, change it under Suppliers.`
        : `${Ref} (${on}) charges ${workings}. Ops has ${$(opsRate)} ${per(r.basis)} ex GST.${allowed} Approve sets ${r.name} from ${$(r.amount ?? 0)} to ${$(to)} ${per(r.basis)} ${gstWord(r)}, the rate, not the line total. Nothing else changes.`,
      change: freightCharge ? null : { target: "rule", feeRuleId: r.id, field: "amount", from: r.amount ?? 0, to },
    });
  }

  // An Ops surcharge the invoice left off. Only surcharges: a broken pack fee
  // that is not there just means it was a full pack.
  for (const r of rules) {
    if (seen.has(r.id) || !r.autoApply || !["fuel", "levy", "premium"].includes(r.kind) || !isChargeLive(r, on)) continue;
    const flat = r.basis === "order" || r.basis === "shipment";
    const qty = r.basis === "percent_of_order" || flat ? null : (goodsQty.get(r.basis) ?? null);
    if (r.basis !== "percent_of_order" && !flat && qty == null) continue; // no goods in that unit to work it out on
    const expected = r.basis === "percent_of_order" ? r2((goodsTotal * (r.percent ?? 0)) / 100) : r2(ruleAmountEx(r) * (qty ?? 1));
    if (expected < 0.5) continue;
    const rate = r.basis === "percent_of_order" ? `${r.percent}%` : `${$(ruleAmountEx(r))} ${per(r.basis)}`;
    flags.push({
      kind: "missing_charge",
      key: `${invoiceId}:f:${r.id}`,
      productId: null,
      feeRuleId: r.id,
      lineText: "",
      opsValue: expected,
      invoiceValue: 0,
      unit: r.basis === "percent_of_order" ? "%" : r.basis,
      qty,
      impactExGst: -expected,
      title: `No ${lc(r.name)} on ${who} ${ref}`,
      detail: `Ops adds ${lc(r.name)} at ${rate} to every ${who} order, ${$(expected)} here${qty != null ? ` on ${Number(qty.toFixed(3))} ${r.basis}` : ""}, and this invoice has none. If ${who} have dropped it, end it under Suppliers.`,
      change: null,
    });
  }

  return flags;
}

/**
 * Write the flags for one invoice. A flag Damien already decided stays
 * decided. An open one that no longer applies is withdrawn, never deleted:
 * it stays on the invoice marked Withdrawn, with why, and the activity log
 * says so (Karndean CI155812, 6 Nov). Never throws: a price check going
 * wrong must not stop an invoice being recorded.
 */
export async function checkInvoicePrices(invoiceId: number) {
  try {
    const drafts = await draftFlags(invoiceId);
    const [inv] = await db.select({ supplierId: schema.supplierInvoices.supplierId }).from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, invoiceId));
    const existing = await db.select().from(schema.priceFlags).where(eq(schema.priceFlags.invoiceId, invoiceId));
    const byKey = new Map(existing.map((e) => [e.dedupeKey, e]));
    const keep = new Set<string>();
    const fresh: FlagDraft[] = [];
    for (const d of drafts) {
      keep.add(d.key);
      const row = {
        invoiceId,
        supplierId: inv?.supplierId ?? null,
        kind: d.kind,
        productId: d.productId,
        feeRuleId: d.feeRuleId,
        lineText: d.lineText.slice(0, 300),
        opsValue: d.opsValue,
        invoiceValue: d.invoiceValue,
        unit: d.unit,
        qty: d.qty,
        impactExGst: d.impactExGst,
        title: d.title.slice(0, 300),
        detail: d.detail.slice(0, 1000),
        change: d.change ? JSON.stringify(d.change) : null,
        dedupeKey: d.key,
      };
      const e = byKey.get(d.key);
      if (!e) {
        await db.insert(schema.priceFlags).values(row);
        fresh.push(d);
      } else if (e.status === "open") await db.update(schema.priceFlags).set({ ...row, updatedAt: new Date() }).where(eq(schema.priceFlags.id, e.id));
      else if (e.status === "withdrawn") {
        // It applies again. Open it again; the log keeps that it was withdrawn once.
        await db.update(schema.priceFlags).set({ ...row, status: "open", decidedAt: null, decidedBy: null, outcome: "", updatedAt: new Date() }).where(eq(schema.priceFlags.id, e.id));
        await logFlag(e, `Price check "${e.title}" applies again on a fresh look at the invoice, so it is open again.`);
      }
    }
    const stale = existing.filter((e) => e.status === "open" && !keep.has(e.dedupeKey));
    for (const e of stale) {
      const outcome = `Withdrawn on recheck: a fresh look at the invoice no longer finds this.${e.change ? " Its update can no longer be approved." : ""}`;
      await db
        .update(schema.priceFlags)
        .set({ status: "withdrawn", decidedAt: new Date(), decidedBy: "Invoice matching", outcome, updatedAt: new Date() })
        .where(and(eq(schema.priceFlags.id, e.id), eq(schema.priceFlags.status, "open")));
      await logFlag(e, `Price check withdrawn: "${e.title}". ${outcome}${e.change ? ` The update it offered was ${e.change}.` : ""}`);
    }
    await alertFlags(invoiceId, fresh);
    return drafts.length;
  } catch (e) {
    console.error(`[price-check] invoice ${invoiceId}:`, (e as Error).message);
    return 0;
  }
}

/** One line in the activity log against the invoice, so a withdrawn or reopened check is never silent. */
async function logFlag(e: typeof schema.priceFlags.$inferSelect, detail: string) {
  await db.insert(schema.activityLog).values({
    entityType: "supplier_invoice",
    entityId: e.invoiceId,
    action: "price_check_rechecked",
    detail: `${detail} (price check ${e.id})`.slice(0, 2000),
    actorName: "Invoice matching",
    actorRole: "system",
  });
}

/** Kinds that are notes for the office, with no money to decide on. They never alert. */
const QUIET_KINDS = new Set(["invoice_special", "charge_mapping"]);

/**
 * Tell the office about NEW flags on an invoice. One alert per invoice, never
 * on a recheck of a flag already seen. A special billed under the price list
 * is good news with nothing to decide, so it never alerts. Over $50 is its own
 * kind, urgent by default, so it emails straight away. Never texts. Never throws.
 */
async function alertFlags(invoiceId: number, fresh: FlagDraft[]) {
  const real = fresh.filter((d) => !QUIET_KINDS.has(d.kind));
  if (!real.length) return;
  try {
    const big = real.filter((d) => Math.abs(d.impactExGst) > EMAIL_OVER_EX_GST);
    const shown = big.length ? big : real;
    const [inv] = await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, invoiceId));
    const [sup] = inv?.supplierId ? await db.select({ name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.id, inv.supplierId)) : [];
    const total = r2(shown.reduce((t, d) => t + d.impactExGst, 0));
    const first = shown[0]!.title.length > 70 ? `${shown[0]!.title.slice(0, 67)}...` : shown[0]!.title;
    const lead = `${first}${real.length > 1 ? ` (+${real.length - 1} more)` : ""}`;
    await notifyOffice(big.length ? "price_flag_big" : "price_flag", {
      title: `Price check: ${sup?.name ?? "Supplier"} invoice ${inv?.invoiceNumber ?? ""}`.trim(),
      body:
        `${sup?.name ?? "Supplier"} invoice ${inv?.invoiceNumber ?? ""} is ${$(total)} ex GST ${total >= 0 ? "over" : "under"} the price list. ` +
        `${lead}${/[.]$/.test(lead) ? "" : "."} Approve or ignore under Suppliers owed.`,
      path: "/finance/suppliers-owed",
      data: { kind: "payables", invoiceId },
    });
  } catch (e) {
    console.error(`[price-check] alert for invoice ${invoiceId}:`, (e as Error).message);
  }
}

/** Re-check every invoice with an open flag on the same product or rule, after one was approved. */
async function recheckTarget(flag: typeof schema.priceFlags.$inferSelect) {
  const cond = flag.productId ? eq(schema.priceFlags.productId, flag.productId) : flag.feeRuleId ? eq(schema.priceFlags.feeRuleId, flag.feeRuleId) : null;
  if (!cond) return;
  const others = await db
    .select({ invoiceId: schema.priceFlags.invoiceId })
    .from(schema.priceFlags)
    .where(and(cond, eq(schema.priceFlags.status, "open"), ne(schema.priceFlags.id, flag.id)));
  for (const invoiceId of new Set(others.map((o) => o.invoiceId))) await checkInvoicePrices(invoiceId);
}

const auDay = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "no date");

export class FlagError extends Error {}

/** Damien says yes. Changes that one rate, logs it against the invoice, and nothing else. */
export async function approveFlag(flagId: number, actor: string) {
  const [flag] = await db.select().from(schema.priceFlags).where(eq(schema.priceFlags.id, flagId));
  if (!flag) throw new FlagError("Price check not found.");
  if (flag.status !== "open") throw new FlagError(flag.status === "withdrawn" ? "Withdrawn on recheck: a fresh look at the invoice no longer finds this, so it cannot be approved." : "Already decided.");
  if (!flag.change) throw new FlagError("Nothing to change on this one. Ignore it once it is sorted.");
  // Read the invoice again first. An update the invoice no longer supports is never applied.
  const now = (await draftFlags(flag.invoiceId)).find((d) => d.key === flag.dedupeKey);
  if (!now || !now.change || JSON.stringify(now.change) !== flag.change) {
    await checkInvoicePrices(flag.invoiceId);
    throw new FlagError(
      now
        ? "A fresh look at the invoice gives a different answer, so this update was not applied. Look at it again."
        : "A fresh look at the invoice no longer finds this, so the update was not applied and the check is withdrawn.",
    );
  }
  const change = JSON.parse(flag.change) as FlagChange;
  const [inv] = await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, flag.invoiceId));
  const [sup] = flag.supplierId ? await db.select({ name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.id, flag.supplierId)) : [];
  const source = `${sup?.name ?? "supplier"} invoice ${inv?.invoiceNumber ?? "?"} (${auDay(inv?.invoiceDate ?? null)})`;
  let outcome: string;

  if (change.target === "product") {
    const [p] = await db.select().from(schema.products).where(eq(schema.products.id, change.productId));
    if (!p) throw new FlagError("That product is no longer in the price list.");
    if (p.costPrice === null || Math.abs(p.costPrice - change.from) > 0.005) {
      await checkInvoicePrices(flag.invoiceId);
      throw new FlagError(`The price list changed since this was checked (now ${p.costPrice === null ? "no price" : $(p.costPrice)}). Look at it again.`);
    }
    // Standard chain, cost x 1.3 x 1.05 x 1.4. Specials never come through here.
    const sell = sellExGst(change.to);
    await db.update(schema.products).set({ costPrice: change.to, sellPrice: sell, updatedAt: new Date() }).where(eq(schema.products.id, p.id));
    outcome = `Cost ${$(change.from)} to ${$(change.to)} a ${p.unit}, sell ${p.sellPrice === null ? "none" : $(p.sellPrice)} to ${$(sell)}. Off ${source}.`;
    await db.insert(schema.activityLog).values({
      entityType: "product",
      entityId: p.id,
      action: "standard_price_changed",
      detail: `${outcome} Approved by ${actor}.`,
      actorName: actor,
      actorRole: "admin",
    });
  } else {
    const [r] = await db.select().from(schema.supplierFeeRules).where(eq(schema.supplierFeeRules.id, change.feeRuleId));
    if (!r) throw new FlagError("That supplier charge is no longer in Ops.");
    const current = change.field === "amount" ? r.amount : change.field === "percent" ? r.percent : r.percentBase;
    const same = typeof change.from === "number" ? Math.abs(Number(current ?? 0) - change.from) <= 0.0001 : current === change.from;
    if (!same) {
      await checkInvoicePrices(flag.invoiceId);
      throw new FlagError(`${r.name} changed since this was checked. Look at it again.`);
    }
    const say = (v: number | string) =>
      change.field === "percent" ? `${v}%` : change.field === "amount" ? $(Number(v)) : v === "goods_and_charges" ? "goods plus charges" : "goods only";
    outcome = `${r.name}: ${say(change.from)} to ${say(change.to)}. Off ${source}.`;
    // The rule's own wording can say the opposite of what was just approved. Put the change first so nobody reads a stale condition.
    const stamp = `UPDATED ${auDay(todayISO())}, approved by ${actor}: ${outcome} This overrides anything below that says otherwise.`;
    await db
      .update(schema.supplierFeeRules)
      .set({ [change.field]: change.to, condition: r.condition ? `${stamp} ${r.condition}` : stamp, updatedAt: new Date() })
      .where(eq(schema.supplierFeeRules.id, r.id));
    await db.insert(schema.activityLog).values({
      entityType: "supplier_fee_rule",
      entityId: r.id,
      action: "charge_changed",
      detail: `${outcome} Approved by ${actor}.`,
      actorName: actor,
      actorRole: "admin",
    });
  }

  await db
    .update(schema.priceFlags)
    .set({ status: "approved", decidedAt: new Date(), decidedBy: actor, outcome, updatedAt: new Date() })
    .where(eq(schema.priceFlags.id, flag.id));
  await recheckTarget(flag);
  return { outcome };
}

/** Damien says leave it. The price list is not touched. */
export async function ignoreFlag(flagId: number, actor: string) {
  const [flag] = await db.select().from(schema.priceFlags).where(eq(schema.priceFlags.id, flagId));
  if (!flag) throw new FlagError("Price check not found.");
  if (flag.status !== "open") throw new FlagError(flag.status === "withdrawn" ? "Withdrawn on recheck, nothing to ignore." : "Already decided.");
  await db
    .update(schema.priceFlags)
    .set({ status: "ignored", decidedAt: new Date(), decidedBy: actor, outcome: "Ignored. Price list left as it was.", updatedAt: new Date() })
    .where(eq(schema.priceFlags.id, flag.id));
}
