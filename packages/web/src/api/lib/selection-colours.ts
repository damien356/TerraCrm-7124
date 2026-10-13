import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { categoryLabel } from "./product-categories";
import { markupOf } from "./pricing";
import { notifyOffice } from "./notify";
import { jobText } from "./refs";
import { signGet } from "./s3";
import {
  acceptedQuoteFor,
  addOtherLine,
  bad,
  createVariation,
  deleteVariation,
  itemsOf,
  money,
  productLineName,
  removeLine,
  round2,
  type Variation,
} from "./variations";

/* ---------------------------------------------------------------------------
 * Item 8 (fix list 13 Oct). The material selection form is one section per
 * product on the accepted quote, not per room. Each section shows the quoted
 * colour (with its swatch when the Price list has one). The client confirms
 * it, or picks another colour from the SAME range. Nothing else can be picked.
 *
 *   same price  the material to order changes to the new colour straight away
 *   cheaper     the material changes, and the office gets a task: keep the
 *               quoted price, or credit it with a variation
 *   dearer      a draft variation for the office with the difference. Never
 *               sent by itself, never to a homeowner on a company billed job.
 *               The material changes when that variation is accepted.
 *
 * The client can change the form again until any material on the job is
 * ordered. The old room by room forms still open as they were.
 * ------------------------------------------------------------------------- */

type Product = typeof schema.products.$inferSelect;
type Selection = typeof schema.materialSelections.$inferSelect;
type SelItem = typeof schema.materialSelectionItems.$inferSelect;
type QuoteLine = typeof schema.quoteItems.$inferSelect;

export const FLOOR_CATEGORIES = new Set([
  "carpet",
  "outdoor_carpet",
  "carpet_tile",
  "vinyl",
  "hybrid",
  "laminate",
  "engineered_timber",
  "solid_timber",
  "timber",
  "turf",
]);

/** Floors, plus trims and scotia that come in a colour. Not underlay, adhesive or plain accessories. */
export const isSectionProduct = (p: Pick<Product, "category" | "colour">) =>
  FLOOR_CATEGORIES.has(p.category) || (p.category === "accessory" && !!p.colour.trim());

/** A form made from the quote's products, rather than an old room by room one. */
export const isProductForm = (items: Pick<SelItem, "quotedProductId">[]) => items.some((i) => i.quotedProductId != null);

const ORDERED = ["ordered", "on_site", "installed"];

/** The client can change the form until anything on the job is ordered. */
export async function lockState(jobId: number): Promise<{ locked: boolean; reason: string | null }> {
  const [job] = await db.select({ completedAt: schema.jobs.completedAt }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (job?.completedAt) return { locked: true, reason: "This job is finished, so the colours can no longer be changed here." };
  const [ordered] = await db
    .select({ id: schema.jobMaterials.id })
    .from(schema.jobMaterials)
    .where(and(eq(schema.jobMaterials.jobId, jobId), inArray(schema.jobMaterials.status, ORDERED)))
    .limit(1);
  if (ordered) return { locked: true, reason: "Your flooring has been ordered, so the colours can no longer be changed here. Call or reply to us if you need anything." };
  return { locked: false, reason: null };
}

/** The other colours of the same range: same supplier, brand, range, type, size, backing, thickness and width. */
export async function rangeColours(p: Product): Promise<Product[]> {
  const rows = await db
    .select()
    .from(schema.products)
    .where(
      and(
        eq(schema.products.supplier, p.supplier),
        eq(schema.products.brand, p.brand),
        eq(schema.products.range, p.range),
        eq(schema.products.category, p.category),
        eq(schema.products.size, p.size),
        eq(schema.products.backing, p.backing),
        eq(schema.products.unit, p.unit),
      ),
    )
    .orderBy(asc(schema.products.colour), asc(schema.products.id));
  const same = (a: number | null, b: number | null) => (a ?? null) === (b ?? null);
  const out = rows.filter(
    (r) =>
      r.id === p.id ||
      (r.active && !!r.colour.trim() && (r.supplierId ?? null) === (p.supplierId ?? null) && same(r.thicknessMm, p.thicknessMm) && same(r.widthM, p.widthM)),
  );
  // One per colour name. The quoted one wins a tie.
  const seen = new Map<string, Product>();
  for (const r of out) {
    const k = r.colour.trim().toLowerCase();
    if (!seen.has(k) || r.id === p.id) seen.set(k, r);
  }
  return [...seen.values()].sort((a, b) => a.colour.localeCompare(b.colour));
}

/** The quote's product lines grouped by product, in quote order. Only floors and coloured trims. */
export async function quoteSections(quoteId: number) {
  const lines = await db
    .select({ line: schema.quoteItems, product: schema.products })
    .from(schema.quoteItems)
    .innerJoin(schema.products, eq(schema.products.id, schema.quoteItems.productId))
    .where(and(eq(schema.quoteItems.quoteId, quoteId), inArray(schema.quoteItems.kind, ["supply", "accessory"])))
    .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
  const groups = new Map<number, { product: Product; lines: QuoteLine[] }>();
  for (const r of lines) {
    if (!isSectionProduct(r.product)) continue;
    const g = groups.get(r.product.id) ?? { product: r.product, lines: [] };
    g.lines.push(r.line);
    groups.set(r.product.id, g);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    qty: round2(g.lines.reduce((s, l) => s + (l.qty ?? 0), 0)),
    unit: g.lines[0]?.unit ?? g.product.unit,
  }));
}

/**
 * What a different colour does to the price, per unit ex GST. The cost
 * difference at the quote line's own markup, so a builder's rate stays a
 * builder's rate. Falls back to the price book sell difference when a cost
 * is missing.
 */
export function perUnitChange(lines: QuoteLine[], quoted: Product, picked: Product) {
  if (picked.id === quoted.id) return { sell: 0, cost: 0 };
  const costDiff = quoted.costPrice != null && picked.costPrice != null ? picked.costPrice - quoted.costPrice : null;
  const sellDiff = (picked.sellPrice ?? 0) - (quoted.sellPrice ?? 0);
  let qty = 0;
  let sum = 0;
  for (const l of lines) {
    const mk = l.markupPercent ?? markupOf(l.unitCost, l.unitPrice);
    const d = costDiff != null && mk != null ? costDiff * (1 + mk / 100) : sellDiff;
    qty += l.qty ?? 0;
    sum += (l.qty ?? 0) * d;
  }
  const sell = qty > 0 ? round2(sum / qty) : round2(sellDiff);
  return { sell, cost: costDiff != null ? round2(costDiff) : 0 };
}

export type ChangeKind = "same" | "swap" | "cheaper" | "dearer";
export const changeKindOf = (quotedId: number, pickedId: number, extraExGst: number): ChangeKind =>
  pickedId === quotedId ? "same" : extraExGst > 0.004 ? "dearer" : extraExGst < -0.004 ? "cheaper" : "swap";

const sectionTitle = (p: Product) => [p.brand, p.range].filter(Boolean).join(" ") || p.range || p.colour;
const kindLabelOf = (p: Product) => (p.category === "accessory" ? "Trim" : categoryLabel(p.category));
const qtyText = (qty: number | null, unit: string | null) => (qty ? `${round2(qty)} ${unit === "m2" ? "m²" : (unit ?? "")}`.trim() : "");
const ids = (json: string): number[] => {
  try {
    const a = JSON.parse(json || "[]");
    return Array.isArray(a) ? a.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
};

async function productsById(list: (number | null | undefined)[]) {
  const want = [...new Set(list.filter((n): n is number => typeof n === "number"))];
  if (!want.length) return new Map<number, Product>();
  const rows = await db.select().from(schema.products).where(inArray(schema.products.id, want));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function swatchUrlOf(p: Pick<Product, "swatchKey"> | null | undefined) {
  if (!p?.swatchKey) return null;
  try {
    return await signGet(p.swatchKey, 6 * 3600);
  } catch {
    return null;
  }
}

/** The new form's rows for a job: one per product on the accepted quote. */
export async function productItemsFor(jobId: number, selectionId: number) {
  const quote = await acceptedQuoteFor(jobId);
  if (!quote) throw bad("This job has no accepted quote, so there is nothing for the client to choose.");
  const sections = await quoteSections(quote.id);
  if (!sections.length) throw bad("The accepted quote has no floors or coloured trims to choose.");
  const mats = await db
    .select({ id: schema.jobMaterials.id, productId: schema.jobMaterials.productId })
    .from(schema.jobMaterials)
    .where(and(eq(schema.jobMaterials.jobId, jobId), eq(schema.jobMaterials.status, "to_order")));
  return {
    quoteId: quote.id,
    rows: sections.map((s, i) => ({
      selectionId,
      room: "",
      product: sectionTitle(s.product),
      colour: s.product.colour,
      notes: "",
      sortOrder: i,
      quoteItemId: s.lines[0]?.id ?? null,
      quotedProductId: s.product.id,
      productId: s.product.id,
      qty: s.qty,
      unit: s.unit,
      extraExGst: 0,
      materialIds: JSON.stringify(mats.filter((m) => m.productId === s.product.id).map((m) => m.id)),
    })),
  };
}

/** Whether the client may see dollar figures: not on a company billed job, unless they work at that company. */
export async function pricesShownTo(sel: Selection) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, sel.jobId));
  const quote = await acceptedQuoteFor(sel.jobId);
  const companyId = quote?.companyId ?? (job?.billToType === "company" ? (job.billToCompanyId ?? job.companyId) : null);
  if (!companyId) return { show: true, company: null as string | null };
  const [co] = await db.select({ name: schema.companies.name }).from(schema.companies).where(eq(schema.companies.id, companyId));
  if (sel.contactId) {
    const [link] = await db
      .select({ id: schema.companyContacts.id })
      .from(schema.companyContacts)
      .where(and(eq(schema.companyContacts.companyId, companyId), eq(schema.companyContacts.contactId, sel.contactId)))
      .limit(1);
    if (link) return { show: true, company: co?.name ?? null };
  }
  return { show: false, company: co?.name ?? null };
}

async function quoteLinesOf(quoteId: number | null, productId: number) {
  if (!quoteId) return [];
  return db
    .select()
    .from(schema.quoteItems)
    .where(and(eq(schema.quoteItems.quoteId, quoteId), eq(schema.quoteItems.productId, productId)));
}

/** The client's page: each section with its colours, swatches and what each one does to the price. */
export async function publicSections(sel: Selection, items: SelItem[]) {
  const prices = await pricesShownTo(sel);
  const byId = await productsById(items.flatMap((i) => [i.quotedProductId, i.productId]));
  const out = [];
  for (const i of items) {
    const quoted = i.quotedProductId ? byId.get(i.quotedProductId) : undefined;
    if (!quoted) continue;
    const lines = await quoteLinesOf(sel.quoteId, quoted.id);
    const colours = await rangeColours(quoted);
    const options = [];
    for (const c of colours) {
      const per = perUnitChange(lines, quoted, c);
      const extra = round2((i.qty ?? 0) * per.sell);
      const kind = changeKindOf(quoted.id, c.id, extra);
      options.push({
        productId: c.id,
        colour: c.colour,
        swatchUrl: await swatchUrlOf(c),
        change: kind,
        extraIncGst: prices.show && (kind === "dearer" || kind === "cheaper") ? round2(extra * 1.1) : null,
      });
    }
    out.push({
      itemId: i.id,
      kindLabel: kindLabelOf(quoted),
      title: sectionTitle(quoted),
      qtyText: qtyText(i.qty, i.unit),
      quotedProductId: quoted.id,
      quotedColour: quoted.colour,
      productId: i.productId ?? quoted.id,
      options,
    });
  }
  return { sections: out, showPrices: prices.show, company: prices.company };
}

/** The office's view of each section. Prices always shown. */
export async function staffSections(items: SelItem[]) {
  const byId = await productsById(items.flatMap((i) => [i.quotedProductId, i.productId]));
  const vids = [...new Set(items.map((i) => i.variationId).filter((n): n is number => !!n))];
  const vars = vids.length ? await db.select().from(schema.variations).where(inArray(schema.variations.id, vids)) : [];
  return items
    .filter((i) => i.quotedProductId)
    .map((i) => {
      const quoted = byId.get(i.quotedProductId!);
      const picked = byId.get(i.productId ?? i.quotedProductId!) ?? quoted;
      const extra = i.extraExGst ?? 0;
      const v = i.variationId ? vars.find((x) => x.id === i.variationId) : undefined;
      return {
        id: i.id,
        title: quoted ? sectionTitle(quoted) : i.product,
        kindLabel: quoted ? kindLabelOf(quoted) : "",
        qtyText: qtyText(i.qty, i.unit),
        quotedColour: quoted?.colour ?? i.colour,
        colour: picked?.colour ?? i.colour,
        change: changeKindOf(i.quotedProductId!, i.productId ?? i.quotedProductId!, extra),
        extraIncGst: round2(extra * 1.1),
        variation: v ? { id: v.id, ref: v.ref, status: v.status } : null,
      };
    });
}

/* ------------------------------- client send ------------------------------- */

async function variationRow(id: number | null | undefined): Promise<Variation | null> {
  if (!id) return null;
  const [v] = await db.select().from(schema.variations).where(eq(schema.variations.id, id));
  return v ?? null;
}

async function moveMaterials(jobId: number, item: SelItem, from: number[], to: Product) {
  let matIds = ids(item.materialIds);
  if (!matIds.length) {
    const rows = await db
      .select({ id: schema.jobMaterials.id })
      .from(schema.jobMaterials)
      .where(and(eq(schema.jobMaterials.jobId, jobId), eq(schema.jobMaterials.status, "to_order"), inArray(schema.jobMaterials.productId, from)));
    matIds = rows.map((r) => r.id);
  }
  if (!matIds.length) return 0;
  const moved = await db
    .update(schema.jobMaterials)
    .set({ productId: to.id, description: productLineName(to) || to.colour, updatedAt: new Date() })
    .where(and(eq(schema.jobMaterials.jobId, jobId), inArray(schema.jobMaterials.id, matIds), eq(schema.jobMaterials.status, "to_order")))
    .returning({ id: schema.jobMaterials.id });
  return moved.length;
}

export type Pick_ = { itemId: number; productId: number };

/** The client sends the new form. Works out each change, then materials, the variation and the office task. */
export async function submitProductSelection(sel: Selection, name: string, picks: Pick_[], notesIn: string) {
  const lock = await lockState(sel.jobId);
  if (lock.locked) throw bad(lock.reason ?? "This form can no longer be changed.");
  const who = name.trim().slice(0, 120);
  const notes = notesIn.trim().slice(0, 2000);
  const items = (
    await db
      .select()
      .from(schema.materialSelectionItems)
      .where(eq(schema.materialSelectionItems.selectionId, sel.id))
      .orderBy(asc(schema.materialSelectionItems.sortOrder), asc(schema.materialSelectionItems.id))
  ).filter((i) => i.quotedProductId);
  if (!items.length) throw bad("This form has nothing to choose.");
  const byId = await productsById(items.flatMap((i) => [i.quotedProductId, i.productId]));

  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, sel.jobId));
  const jobRef = job ? jobText(job) : String(sel.jobId);
  const prices = await pricesShownTo(sel);
  let variationId = sel.variationId;
  const report: string[] = [];
  const log: string[] = [];
  let changed = 0;

  for (const item of items) {
    const quoted = byId.get(item.quotedProductId!);
    if (!quoted) continue;
    const prevId = item.productId ?? quoted.id;
    const wantId = picks.find((p) => p.itemId === item.id)?.productId ?? prevId;
    const colours = await rangeColours(quoted);
    const picked = colours.find((c) => c.id === wantId);
    if (!picked) throw bad(`That colour is not in the ${sectionTitle(quoted)} range. Pick one from the list.`);
    const lines = await quoteLinesOf(sel.quoteId, quoted.id);
    const per = perUnitChange(lines, quoted, picked);
    const qty = item.qty ?? 0;
    const extra = round2(qty * per.sell);
    const kind = changeKindOf(quoted.id, picked.id, extra);
    const title = sectionTitle(quoted);
    let vId = item.variationId;
    let vItemId = item.variationItemId;

    // A pick that moved off the one a variation carries takes its line back out.
    if (vItemId && (picked.id !== prevId || kind !== "dearer")) {
      const v = await variationRow(vId);
      if (v && (v.status === "draft" || v.status === "sent")) {
        const [line] = await db.select().from(schema.variationItems).where(eq(schema.variationItems.id, vItemId));
        if (line) await removeLine(line.id);
        if (v.status === "sent") report.push(`${title}: variation ${v.ref} had already gone out for ${byId.get(prevId)?.colour ?? "the old colour"}. Its line is removed and it is back to draft.`);
      } else if (v && (v.status === "approved" || v.status === "invoiced")) {
        report.push(`${title}: variation ${v.ref} was already accepted for ${byId.get(prevId)?.colour ?? "the old colour"}. Sort that one by hand.`);
      }
      vId = null;
      vItemId = null;
    }

    // Materials: dearer waits for the variation, everything else changes now.
    const target = kind === "dearer" ? quoted : picked;
    const moved = await moveMaterials(sel.jobId, item, [quoted.id, prevId], target);

    if (kind === "dearer" && !vItemId) {
      let v = await variationRow(variationId);
      if (!v || v.status !== "draft" || v.sentAt) {
        v = await createVariation({
          jobId: sel.jobId,
          description: "Colour change from the material selection form.",
          byName: who || "Client",
          actorRole: "customer",
        });
        variationId = v.id;
      }
      const added = await addOtherLine({
        variationId: v.id,
        kind: "other",
        description: `Colour change, ${title}: ${quoted.colour} to ${picked.colour}, ${qtyText(qty, item.unit)}`,
        qty: qty || 1,
        unit: item.unit || quoted.unit,
        unitPrice: qty ? per.sell : extra,
        unitCost: per.cost,
      });
      vId = v.id;
      vItemId = added.item.id;
    }

    await db
      .update(schema.materialSelectionItems)
      .set({ productId: picked.id, product: title, colour: picked.colour, extraExGst: kind === "same" ? 0 : extra, variationId: vId, variationItemId: vItemId, updatedAt: new Date() })
      .where(eq(schema.materialSelectionItems.id, item.id));

    if (kind === "same") {
      log.push(`${title}: ${quoted.colour} as quoted`);
      continue;
    }
    changed++;
    const v = await variationRow(vId);
    if (kind === "swap") {
      report.push(`${title}: ${quoted.colour} to ${picked.colour}. Same price.${moved ? " The material to order is changed." : ""}`);
    } else if (kind === "cheaper") {
      report.push(
        `${title}: ${quoted.colour} to ${picked.colour}, ${money(Math.abs(round2(extra * 1.1)))} inc GST less.${moved ? " The material to order is changed." : ""} Keep the quoted price, or credit it with a variation. Your call.`,
      );
    } else {
      report.push(
        `${title}: ${quoted.colour} to ${picked.colour}, ${money(round2(extra * 1.1))} inc GST more. Draft variation ${v?.ref ?? ""} has it. Check it and send it${prices.company ? ` to ${prices.company}, never the homeowner` : ""}. The material to order stays ${quoted.colour} until it is accepted.`,
      );
    }
    log.push(`${title}: ${quoted.colour} to ${picked.colour}${kind === "dearer" ? ` (+${money(round2(extra * 1.1))})` : kind === "cheaper" ? ` (${money(round2(extra * 1.1))})` : ""}`);
  }

  // A draft this form made that has nothing left on it goes.
  const v = await variationRow(variationId);
  if (v && v.status === "draft" && !v.sentAt && !(await itemsOf(v.id)).length) {
    await deleteVariation(v.id, { name: "Terra Ops", role: "system" });
    variationId = null;
  }

  // One office task per form, kept up to date while it is open.
  let taskId = sel.taskId;
  if (changed || notes || report.length) {
    const detail = [
      `${who || "The client"} sent the material selection.`,
      ...report,
      notes ? `Their note: ${notes}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const title = changed ? `Colour change${changed === 1 ? "" : "s"} to check, job ${jobRef}` : `Material selection note, job ${jobRef}`;
    const [open] = taskId ? await db.select().from(schema.officeTasks).where(eq(schema.officeTasks.id, taskId)) : [];
    if (open && open.status === "open") {
      await db.update(schema.officeTasks).set({ title, detail, updatedAt: new Date() }).where(eq(schema.officeTasks.id, open.id));
    } else {
      const [t] = await db.insert(schema.officeTasks).values({ jobId: sel.jobId, title, detail, createdByName: who || "Client" }).returning();
      taskId = t?.id ?? null;
    }
  }

  const now = new Date();
  await db
    .update(schema.materialSelections)
    .set({ status: "submitted", submittedAt: now, submittedName: who, notes, variationId, taskId, updatedAt: now })
    .where(eq(schema.materialSelections.id, sel.id));

  await db.insert(schema.activityLog).values({
    jobId: sel.jobId,
    entityType: "material_selection",
    entityId: sel.id,
    action: "selection_submitted",
    detail: [`${who || "The client"} sent the material selection.`, ...log, notes ? `Note: ${notes}` : ""].filter(Boolean).join("\n"),
    actorName: who || "Client",
    actorRole: "customer",
  });
  await notifyOffice("selection_done", {
    title: changed ? `Colour change on job ${jobRef}` : `Colours confirmed for job ${jobRef}`,
    body: changed
      ? `${who || "The client"} changed ${changed} colour${changed === 1 ? "" : "s"}. There is a task on the job.`
      : `${who || "The client"} confirmed the quoted colours.${notes ? " They left a note." : " Ready to order."}`,
    data: { kind: "job", jobId: sel.jobId },
  }).catch((e) => console.error("[selection] push failed:", e));
  return { changed };
}

/** A variation is accepted. Any dearer colour it carries goes onto the materials to order now. */
export async function applyAcceptedColours(v: Variation) {
  const items = await db.select().from(schema.materialSelectionItems).where(eq(schema.materialSelectionItems.variationId, v.id));
  let moved = 0;
  for (const item of items) {
    if (!item.productId || !item.quotedProductId || item.productId === item.quotedProductId) continue;
    const [to] = await db.select().from(schema.products).where(eq(schema.products.id, item.productId));
    if (!to) continue;
    const n = await moveMaterials(v.jobId, item, [item.quotedProductId], to);
    moved += n;
    await db.insert(schema.activityLog).values({
      jobId: v.jobId,
      entityType: "material_selection",
      entityId: item.selectionId,
      action: "colour_changed",
      detail: `Variation ${v.ref} accepted. ${item.product} changed to ${to.colour}${n ? " on the materials to order" : ". No material to order was found to change, check the order by hand"}.`,
      actorName: "Terra Ops",
      actorRole: "system",
    });
  }
  return { items: items.length, moved };
}
