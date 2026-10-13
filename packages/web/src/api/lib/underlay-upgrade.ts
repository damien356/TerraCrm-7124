import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { isUnderlayCategory, underlayName, wholeUnits } from "./order-sizes";
import { parsePairs, UNDERLAY_UPGRADES_KEY, type UpgradePair } from "./underlay-pairs";
import { addOtherLine, createVariation, deleteVariation, itemsOf, money, removeLine, round2, type Variation } from "./variations";

/* ---------------------------------------------------------------------------
 * Fix list 11 Oct, item 9. The underlay upgrade offer on the material
 * selection form.
 *
 * When the accepted quote has an underlay that Settings pairs with a better
 * one (Standard to Premium), the form asks "Upgrade to Premium underlay for
 * an extra $X?". $X is the job's underlay metres times the sell price
 * difference in the Price list, inc GST. A different roll width changes the
 * metres, so the price follows the floor area, not just the lm.
 *
 *   Yes, upgrade  a variation for the upgrade, accepted on the spot by the
 *                 client's tap and name (the price was on screen). The job
 *                 value goes up and it goes on the final invoice. The quote
 *                 itself stays locked and no new deposit is taken: Damien's
 *                 variation rules (13 Oct). The underlay to order changes.
 *   No thanks     recorded and logged. Nothing else changes.
 *
 * A company billed job (the client cannot see prices) gets the offer without
 * a price. Yes there makes a draft variation for the office to send to the
 * company, never the homeowner, the same as a dearer colour (item 8). The
 * underlay changes when that variation is accepted.
 *
 * One row per offered underlay in material_selection_items, marked by
 * offer_product_id. The price is fixed when the form is made, so the client
 * always gets the price they saw.
 * ------------------------------------------------------------------------- */

type Product = typeof schema.products.$inferSelect;
type SelItem = typeof schema.materialSelectionItems.$inferSelect;
type Selection = typeof schema.materialSelections.$inferSelect;

export const isUpgradeRow = (i: Pick<SelItem, "offerProductId">) => i.offerProductId != null;
export const ANSWERS = ["", "yes", "no"] as const;
export type Answer = (typeof ANSWERS)[number];

export async function upgradePairs(): Promise<UpgradePair[]> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, UNDERLAY_UPGRADES_KEY));
  return parsePairs(row?.value);
}

const toM2 = (qty: number, unit: string, widthM: number | null) =>
  unit === "m2" ? qty : unit === "lm" && widthM && widthM > 0 ? qty * widthM : null;

export type Offer =
  | { ok: true; newQty: number; newUnit: string; extraExGst: number; costExGst: number | null; perUnitExGst: number }
  | { ok: false; reason: string };

/**
 * What the upgrade costs for this much of the quoted underlay. Sell price
 * difference from the Price list, ex GST. Lm with a different roll width,
 * and m² against lm, go through the floor area.
 */
export function priceOffer(quoted: Product, upgrade: Product, qty: number, unitIn?: string | null): Offer {
  const unit = unitIn || quoted.unit;
  if (!(qty > 0)) return { ok: false, reason: "The quote has no underlay quantity." };
  if (quoted.sellPrice == null || upgrade.sellPrice == null) return { ok: false, reason: "One of the underlays has no sell price in the Price list." };
  let newQty: number;
  if (unit === upgrade.unit && (unit !== "lm" || !quoted.widthM || !upgrade.widthM || quoted.widthM === upgrade.widthM)) {
    newQty = qty;
  } else {
    const area = toM2(qty, unit, quoted.widthM);
    const back = area == null ? null : upgrade.unit === "m2" ? area : upgrade.unit === "lm" && upgrade.widthM ? area / upgrade.widthM : null;
    if (back == null) return { ok: false, reason: `The units do not match (${unit} and ${upgrade.unit}), so it cannot be priced. Add the roll widths, or pick an underlay sold the same way.` };
    newQty = wholeUnits(upgrade, round2(back)).qty;
  }
  const extra = round2(newQty * upgrade.sellPrice - qty * quoted.sellPrice);
  if (!(extra > 0.004)) return { ok: false, reason: `${underlayName(upgrade)} is not dearer than ${underlayName(quoted)}, so there is nothing to offer.` };
  const costExGst = quoted.costPrice != null && upgrade.costPrice != null ? round2(newQty * upgrade.costPrice - qty * quoted.costPrice) : null;
  return { ok: true, newQty: round2(newQty), newUnit: upgrade.unit, extraExGst: extra, costExGst, perUnitExGst: round2(upgrade.sellPrice - quoted.sellPrice) };
}

const qtyText = (qty: number | null, unit: string | null) => (qty ? `${round2(qty)} ${unit === "m2" ? "m²" : (unit ?? "")}`.trim() : "");
const ids = (json: string): number[] => {
  try {
    const a = JSON.parse(json || "[]");
    return Array.isArray(a) ? a.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
};

/** The underlay lines on a quote, one group per product, in quote order. */
async function quoteUnderlays(quoteId: number) {
  const rows = await db
    .select({ line: schema.quoteItems, product: schema.products })
    .from(schema.quoteItems)
    .innerJoin(schema.products, eq(schema.products.id, schema.quoteItems.productId))
    .where(and(eq(schema.quoteItems.quoteId, quoteId), inArray(schema.quoteItems.kind, ["supply", "accessory"])))
    .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
  const groups = new Map<number, { product: Product; firstLineId: number; qty: number; unit: string }>();
  for (const r of rows) {
    if (!isUnderlayCategory(r.product.category)) continue;
    const g = groups.get(r.product.id) ?? { product: r.product, firstLineId: r.line.id, qty: 0, unit: r.line.unit || r.product.unit };
    g.qty = round2(g.qty + (r.line.qty ?? 0));
    groups.set(r.product.id, g);
  }
  return [...groups.values()];
}

/** The upgrade rows a new form gets: one per quoted underlay that has a pair in Settings and prices up. */
export async function upgradeRowsFor(jobId: number, quoteId: number, selectionId: number, startSort: number) {
  const pairs = await upgradePairs();
  if (!pairs.length) return [];
  const underlays = await quoteUnderlays(quoteId);
  if (!underlays.length) return [];
  const want = pairs.filter((p) => underlays.some((u) => u.product.id === p.from)).map((p) => p.to);
  const targets = want.length ? await db.select().from(schema.products).where(inArray(schema.products.id, want)) : [];
  const mats = await db
    .select({ id: schema.jobMaterials.id, productId: schema.jobMaterials.productId })
    .from(schema.jobMaterials)
    .where(and(eq(schema.jobMaterials.jobId, jobId), eq(schema.jobMaterials.status, "to_order")));
  const rows: (typeof schema.materialSelectionItems.$inferInsert)[] = [];
  for (const u of underlays) {
    const pair = pairs.find((p) => p.from === u.product.id);
    const to = pair ? targets.find((t) => t.id === pair.to) : undefined;
    if (!to || !to.active || !isUnderlayCategory(to.category)) continue;
    const offer = priceOffer(u.product, to, u.qty, u.unit);
    if (!offer.ok) continue;
    rows.push({
      selectionId,
      room: "",
      product: underlayName(u.product),
      colour: u.product.colour,
      notes: "",
      sortOrder: startSort + rows.length,
      quoteItemId: u.firstLineId,
      quotedProductId: u.product.id,
      productId: u.product.id,
      qty: u.qty,
      unit: u.unit,
      extraExGst: offer.extraExGst,
      materialIds: JSON.stringify(mats.filter((m) => m.productId === u.product.id).map((m) => m.id)),
      offerProductId: to.id,
      answer: "",
    });
  }
  return rows;
}

/** A form made before the pairs were set (or before item 9) gets its offers when the office sends it again. */
export async function addMissingUpgradeRows(sel: Selection, items: SelItem[]) {
  if (!sel.quoteId || items.some(isUpgradeRow)) return 0;
  const start = items.reduce((m, i) => Math.max(m, i.sortOrder), -1) + 1;
  const rows = await upgradeRowsFor(sel.jobId, sel.quoteId, sel.id, start);
  if (rows.length) await db.insert(schema.materialSelectionItems).values(rows);
  return rows.length;
}

async function productsById(list: (number | null | undefined)[]) {
  const want = [...new Set(list.filter((n): n is number => typeof n === "number"))];
  if (!want.length) return new Map<number, Product>();
  const rows = await db.select().from(schema.products).where(inArray(schema.products.id, want));
  return new Map(rows.map((r) => [r.id, r]));
}

async function variationsById(list: (number | null | undefined)[]) {
  const want = [...new Set(list.filter((n): n is number => typeof n === "number"))];
  if (!want.length) return new Map<number, Variation>();
  const rows = await db.select().from(schema.variations).where(inArray(schema.variations.id, want));
  return new Map(rows.map((r) => [r.id, r]));
}

const isAccepted = (v: Variation | undefined) => !!v && (v.status === "approved" || v.status === "invoiced");

/** The client's page. No price when this person may not see prices. */
export async function publicOffers(items: SelItem[], showPrices: boolean) {
  const rows = items.filter(isUpgradeRow);
  if (!rows.length) return [];
  const byId = await productsById(rows.flatMap((i) => [i.quotedProductId, i.offerProductId]));
  const vars = await variationsById(rows.map((i) => i.variationId));
  return rows.flatMap((i) => {
    const from = byId.get(i.quotedProductId!);
    const to = byId.get(i.offerProductId!);
    if (!from || !to) return [];
    const v = i.variationId ? vars.get(i.variationId) : undefined;
    return [
      {
        itemId: i.id,
        fromName: underlayName(from),
        toName: underlayName(to),
        qtyText: qtyText(i.qty, i.unit),
        extraIncGst: showPrices ? round2((i.extraExGst ?? 0) * 1.1) : null,
        answer: (ANSWERS as readonly string[]).includes(i.answer) ? (i.answer as Answer) : ("" as Answer),
        /** Yes went through and was accepted, so it cannot be taken back here. */
        settled: i.answer === "yes" && isAccepted(v),
      },
    ];
  });
}

/** The office's view on the job page. */
export async function staffOffers(items: SelItem[]) {
  const rows = items.filter(isUpgradeRow);
  if (!rows.length) return [];
  const byId = await productsById(rows.flatMap((i) => [i.quotedProductId, i.offerProductId]));
  const vars = await variationsById(rows.map((i) => i.variationId));
  return rows.map((i) => {
    const from = byId.get(i.quotedProductId!);
    const to = byId.get(i.offerProductId!);
    const v = i.variationId ? vars.get(i.variationId) : undefined;
    return {
      id: i.id,
      fromName: from ? underlayName(from) : i.product,
      toName: to ? underlayName(to) : "",
      qtyText: qtyText(i.qty, i.unit),
      extraIncGst: round2((i.extraExGst ?? 0) * 1.1),
      answer: i.answer,
      variation: v ? { id: v.id, ref: v.ref, status: v.status } : null,
    };
  });
}

export type UpgradeAnswer = { itemId: number; answer: "yes" | "no" };

export type UpgradeOutcome = {
  /** For the office task: only what the office has to act on. */
  report: string[];
  /** For the job's activity log. */
  log: string[];
  upgraded: number;
  declined: number;
  /** The form's shared draft variation, for a company billed job. */
  variationId: number | null;
  /** Variations to accept on the spot once the form is saved. */
  toAccept: number[];
};

/**
 * The client's upgrade answers, inside the form's submit. Works the rows and
 * the variation lines. Accepting waits for the caller (lib/selection-colours),
 * after the form is saved, so the colour changes are in place first.
 */
export async function applyUpgradeAnswers(args: {
  sel: Selection;
  who: string;
  answers: UpgradeAnswer[];
  showPrices: boolean;
  company: string | null;
  variationId: number | null;
}): Promise<UpgradeOutcome> {
  const out: UpgradeOutcome = { report: [], log: [], upgraded: 0, declined: 0, variationId: args.variationId, toAccept: [] };
  const rows = (await db.select().from(schema.materialSelectionItems).where(eq(schema.materialSelectionItems.selectionId, args.sel.id))).filter(isUpgradeRow);
  if (!rows.length) return out;
  const byId = await productsById(rows.flatMap((i) => [i.quotedProductId, i.offerProductId]));
  const vars = await variationsById(rows.map((i) => i.variationId));

  for (const row of rows) {
    const from = byId.get(row.quotedProductId!);
    const to = byId.get(row.offerProductId!);
    if (!from || !to) continue;
    const label = `${underlayName(from)} to ${underlayName(to)}`;
    const incGst = round2((row.extraExGst ?? 0) * 1.1);
    const want = args.answers.find((a) => a.itemId === row.id)?.answer ?? (row.answer as Answer);
    const v = row.variationId ? vars.get(row.variationId) : undefined;

    // An accepted yes stays a yes. The client cannot undo it from the form.
    if (row.answer === "yes" && isAccepted(v)) {
      if (want === "yes") out.upgraded++;
      continue;
    }
    if (!want) continue;

    if (want === "no") {
      // Taking back a yes that is still a draft takes its line back out.
      if (row.variationItemId && v && (v.status === "draft" || v.status === "sent")) {
        const [line] = await db.select().from(schema.variationItems).where(eq(schema.variationItems.id, row.variationItemId));
        if (line) await removeLine(line.id);
        // Its own variation (not the form's shared draft) goes when nothing is left on it.
        if (v.id !== out.variationId && v.status === "draft" && !v.sentAt && !(await itemsOf(v.id)).length) {
          await deleteVariation(v.id, { name: "Terra Ops", role: "system" });
        }
        if (v.status === "sent") out.report.push(`Underlay upgrade, ${label}: the client changed to no thanks. The line is out of variation ${v.ref} and it is back to draft.`);
      }
      await db
        .update(schema.materialSelectionItems)
        .set({ answer: "no", productId: from.id, variationId: null, variationItemId: null, updatedAt: new Date() })
        .where(eq(schema.materialSelectionItems.id, row.id));
      if (row.answer !== "no") out.log.push(`Underlay upgrade to ${underlayName(to)}: no thanks`);
      out.declined++;
      continue;
    }

    // Yes.
    out.upgraded++;
    if (row.answer === "yes" && row.variationItemId && v && v.status !== "rejected") continue;
    const line = {
      kind: "other" as const,
      description: `Underlay upgrade, ${label}, ${qtyText(row.qty, row.unit)}`,
      qty: 1,
      unit: "each",
      unitPrice: row.extraExGst ?? 0,
      unitCost: null as number | null,
    };
    let vId: number;
    if (args.showPrices) {
      // Its own variation, accepted once the form is saved.
      const nv = await createVariation({
        jobId: args.sel.jobId,
        description: "Underlay upgrade from the material selection form.",
        byName: args.who || "Client",
        actorRole: "customer",
      });
      vId = nv.id;
      out.toAccept.push(nv.id);
    } else {
      // Company billed: the form's draft for the office to send to the company.
      let draft = out.variationId ? (await variationsById([out.variationId])).get(out.variationId) : undefined;
      if (!draft || draft.status !== "draft" || draft.sentAt) {
        draft = await createVariation({
          jobId: args.sel.jobId,
          description: "From the material selection form.",
          byName: args.who || "Client",
          actorRole: "customer",
        });
        out.variationId = draft.id;
      }
      vId = draft.id;
      out.report.push(
        `Underlay upgrade, ${label}: the client said yes. ${money(incGst)} inc GST is on draft variation ${draft.ref}. Check it and send it${args.company ? ` to ${args.company}, never the homeowner` : ""}. The underlay to order stays ${underlayName(from)} until it is accepted.`,
      );
    }
    const cost = await costOf(from, to, row);
    const added = await addOtherLine({ variationId: vId, ...line, unitCost: cost });
    await db
      .update(schema.materialSelectionItems)
      .set({ answer: "yes", productId: to.id, variationId: vId, variationItemId: added.item.id, updatedAt: new Date() })
      .where(eq(schema.materialSelectionItems.id, row.id));
    out.log.push(`Underlay upgrade to ${underlayName(to)}: yes${args.showPrices ? ` (+${money(incGst)})` : ""}`);
  }
  return out;
}

async function costOf(from: Product, to: Product, row: SelItem) {
  const o = priceOffer(from, to, row.qty ?? 0, row.unit);
  return o.ok ? o.costExGst : null;
}

/** A variation carrying an upgrade is accepted. The underlay to order changes, metres too when the roll width differs. */
export async function applyAcceptedUpgrade(v: Variation, item: SelItem) {
  const [from] = await db.select().from(schema.products).where(eq(schema.products.id, item.quotedProductId!));
  const [to] = await db.select().from(schema.products).where(eq(schema.products.id, item.offerProductId!));
  if (!from || !to) return 0;
  const offer = priceOffer(from, to, item.qty ?? 0, item.unit);
  const ratio = offer.ok && item.qty ? offer.newQty / item.qty : 1;
  let matIds = ids(item.materialIds);
  if (!matIds.length) {
    const found = await db
      .select({ id: schema.jobMaterials.id })
      .from(schema.jobMaterials)
      .where(and(eq(schema.jobMaterials.jobId, v.jobId), eq(schema.jobMaterials.status, "to_order"), eq(schema.jobMaterials.productId, from.id)));
    matIds = found.map((r) => r.id);
  }
  let moved = 0;
  if (matIds.length) {
    const mats = await db
      .select()
      .from(schema.jobMaterials)
      .where(and(eq(schema.jobMaterials.jobId, v.jobId), inArray(schema.jobMaterials.id, matIds), eq(schema.jobMaterials.status, "to_order")));
    for (const m of mats) {
      const qty = ratio !== 1 && m.qty != null ? round2(m.qty * ratio) : m.qty;
      await db
        .update(schema.jobMaterials)
        .set({ productId: to.id, description: underlayName(to), qty, unit: ratio !== 1 ? to.unit : m.unit, updatedAt: new Date() })
        .where(eq(schema.jobMaterials.id, m.id));
      moved++;
    }
  }
  await db.insert(schema.activityLog).values({
    jobId: v.jobId,
    entityType: "material_selection",
    entityId: item.selectionId,
    action: "underlay_upgraded",
    detail: `Variation ${v.ref} accepted. ${underlayName(from)} upgraded to ${underlayName(to)}${
      moved ? ` on the materials to order${ratio !== 1 && offer.ok ? `, now ${qtyText(offer.newQty, offer.newUnit)} for the different roll width` : ""}` : ". No underlay to order was found to change, check the order by hand"
    }.`,
    actorName: "Terra Ops",
    actorRole: "system",
  });
  return moved;
}
