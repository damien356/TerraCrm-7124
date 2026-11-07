/**
 * Quote defaults (Damien's brief, 6 Nov 2026). Writes the lines. What goes
 * on with what lives in quote-default-rules.ts.
 *
 *  - A measured floor line on an installation quote gets its defaults put
 *    on underneath it, selected: underlay, uplift, skim, coving and the rest.
 *  - A scotia or trim line gets Install trims/scotia under it, unless one is
 *    already on the quote, which then covers it (no second charge). Each
 *    laminate or hybrid area has its own, for its own length (7 Nov).
 *  - A Carpet uplift line, put on by default or by hand, gets the Terra
 *    carpet disposal allowance under it (kind internal_charge).
 *
 * Each default is linked to its line by default_for_item_id, never by
 * labour_for_item_id, so the install's own qty rule never moves it. The keys
 * put on are kept on the parent line (defaults_applied), so a default
 * removed by hand is never put back.
 *
 * Nothing here runs on a supply only sale, on an unticked install (supply
 * only line), or on a quote that is locked. Nothing is backfilled.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { boxM2Of, FLOOR_TYPE_LABELS, floorTypeOf } from "./flooring-qty";
import { INTERNAL_CHARGE } from "./line-kinds";
import { liveSellFor } from "./live-sell";
import { isUnderlayCategory, underlayName } from "./order-sizes";
import { markupOf, sellAtMarkup } from "./pricing";
import {
  appliedOf,
  areaGoneFlag,
  autoKey,
  autoOf,
  coveredKey,
  coveredLineOf,
  DISPOSAL_COST_KEY,
  DISPOSAL_DESCRIPTION,
  DISPOSAL_KEY,
  DISPOSAL_MARKUP_KEY,
  DISPOSAL_NO_QTY_FLAG,
  DISPOSAL_NO_RATE_FLAG,
  DISPOSAL_ORPHAN_FLAG,
  changedFlag,
  AREA_TRIM_WHAT,
  enterFlag,
  FLOOR_DEFAULTS,
  isCommercialSheet,
  isDefaultFlag,
  isDefaultWarning,
  installedKey,
  installedOf,
  keepTrimAddedFor,
  isTrimProduct,
  isNewSkirting,
  SKIRTING_FLAG,
  SKIRTING_KEY,
  SKIRTING_MISSING_MARK,
  isWallVinyl,
  isDomesticSheet,
  needsClassifying,
  notCommercialFlag,
  RATE,
  settingNumber,
  SUPPLY_ONLY_SOURCES,
  TRIM_FLAG,
  TRIM_INSTALL_GONE_FLAG,
  TRIM_KEY,
  TRIM_PICK_FLAG,
  trimOverlapFlag,
  trimTypedFlag,
  trimUnmeasuredFlag,
  unclassifiedFlag,
  withoutEnterFlag,
  withoutTrimAdded,
  UPLIFT_NO_WIDTH_FLAG,
  type FloorDefault,
  type QtyRule,
} from "./quote-default-rules";
import { qtyForLine, standardLabour } from "./quote-labour";
import { slotUnder, startLine } from "./quote-sizes";

type Product = typeof schema.products.$inferSelect;
type Line = typeof schema.quoteItems.$inferSelect;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const same = (a: number, b: number) => Math.abs(a - b) <= 0.0005;
const norm = (s: string | null | undefined) =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");

/** "Carpetmate Super Green underlay", "Hurford's CD Non-Structural Pine Plywood". Same as quotes.productLineName. */
function lineName(p: Product) {
  if (isUnderlayCategory(p.category)) return underlayName(p);
  const named = [p.brand, p.range].filter(Boolean).join(" ");
  return (p.colour ? (named ? `${named} in ${p.colour}` : p.colour) : named) || p.sku || "Product";
}

async function lineOf(id: number) {
  const [l] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, id));
  return l ?? null;
}

async function productOf(id: number | null | undefined) {
  if (id == null) return null;
  const [p] = await db.select().from(schema.products).where(eq(schema.products.id, id));
  return p ?? null;
}

/** True on the quote of a product sale or a materials invoice: supply only, nothing gets put on. */
export async function supplyOnlyQuote(quoteId: number) {
  const [q] = await db.select({ jobId: schema.quotes.jobId }).from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!q?.jobId) return false;
  const [j] = await db.select({ source: schema.jobs.source }).from(schema.jobs).where(eq(schema.jobs.id, q.jobId));
  return (SUPPLY_ONLY_SOURCES as readonly string[]).includes(j?.source ?? "");
}

/**
 * Only a quote still being written (draft, or back for review) gets defaults.
 * A sent or accepted quote is never changed by this, and nor is a supply only sale.
 */
export async function takesDefaults(quoteId: number) {
  const [q] = await db.select({ status: schema.quotes.status }).from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!q || (q.status !== "draft" && q.status !== "needs_review")) return false;
  return !(await supplyOnlyQuote(quoteId));
}

/** The rate book item behind a default, only when it is still the same item: id, name, switched on. */
async function liveRate(r: { id: number; name: string }) {
  const [row] = await db.select().from(schema.labourRateItems).where(eq(schema.labourRateItems.id, r.id));
  if (!row) return { ok: false as const, why: `"${r.name}" is not in the rate book.` };
  if (norm(row.name) !== norm(r.name)) {
    return { ok: false as const, why: `Rate book item ${r.id} is now "${row.name}", not "${r.name}", so it was left off.` };
  }
  if (!row.active) return { ok: false as const, why: `"${r.name}" is switched off in the rate book.` };
  return { ok: true as const, row };
}

/** The price book product behind a default, only when it is still the same product: id, SKU, switched on. */
async function liveProduct(p: { id: number; sku: string; name: string }) {
  const row = await productOf(p.id);
  if (!row) return { ok: false as const, why: `${p.name} (${p.sku}) is not in the price book.` };
  if (norm(row.sku) !== norm(p.sku)) {
    return { ok: false as const, why: `Price book product ${p.id} now has SKU ${row.sku || "none"}, not ${p.sku}, so it was left off.` };
  }
  if (!row.active) return { ok: false as const, why: `${p.name} (${p.sku}) is switched off in the price book.` };
  return { ok: true as const, row };
}

/** Remember which defaults have been put on for a line, so none comes back once removed. */
async function addApplied(lineId: number, keys: string[]) {
  if (!keys.length) return;
  const l = await lineOf(lineId);
  if (!l) return;
  const now = [...new Set([...appliedOf(l.defaultsApplied), ...keys])];
  await db.update(schema.quoteItems).set({ defaultsApplied: JSON.stringify(now) }).where(eq(schema.quoteItems.id, lineId));
}

/** A warning put on again needs reviewing again. */
const NOT_REVIEWED = { defaultReviewedBy: null, defaultReviewedAt: null, defaultReviewNote: null };

/** Flag a line, keeping a flag already on it. */
async function flagLine(lineId: number, reason: string) {
  const l = await lineOf(lineId);
  if (!l) return;
  const text = l.flagged && l.flagReason ? (l.flagReason.includes(reason) ? l.flagReason : `${l.flagReason} ${reason}`) : reason;
  // A new warning on a line marked reviewed needs reviewing again.
  const fresh = text !== l.flagReason || !l.flagged;
  const review = fresh ? NOT_REVIEWED : {};
  await db.update(schema.quoteItems).set({ flagged: true, flagReason: text, ...review, updatedAt: new Date() }).where(eq(schema.quoteItems.id, lineId));
}

/** Insert a default line straight under its parent and the lines already under it. */
async function insertUnder(parent: Line, key: string, values: Omit<typeof schema.quoteItems.$inferInsert, "quoteId">) {
  const sortOrder = await slotUnder(parent);
  const [row] = await db
    .insert(schema.quoteItems)
    .values({
      ...values,
      quoteId: parent.quoteId,
      floorCategory: values.floorCategory ?? parent.floorCategory,
      defaultForItemId: parent.id,
      defaultKey: key,
      sortOrder,
    })
    .returning();
  return row ?? null;
}

/** m2 in one plywood sheet: the sheet's own m2, else the box sum. */
const sheetM2 = (p: Product | null) => (p ? (p.unitM2 && p.unitM2 > 0 ? p.unitM2 : boxM2Of(p)) : null);

/**
 * The qty a default starts at off its floor line, or null when it does not
 * follow the floor (typed in, or underlay, which follows by its own rule).
 */
export function autoQty(rule: QtyRule, floor: Line, floorProduct: Product, defProduct?: Product | null): number | null {
  const measured = floor.measuredM2;
  if (measured == null) return null;
  switch (rule) {
    case "measured_m2":
      return r4(measured);
    case "uplift_lm": {
      // Measured over the roll width, no wastage, up to the next 0.1 lm (the same as carpet lm).
      const w = qtyForLine(floorProduct, floor)?.widthM ?? null;
      return w ? Math.ceil((measured / w) * 10 - 1e-9) / 10 : 0;
    }
    case "sheets": {
      const m2 = sheetM2(defProduct ?? null);
      return m2 ? Math.ceil(measured / m2 - 1e-9) : 0;
    }
    default:
      return null;
  }
}

/** The floor rule behind a default line, off its key. */
function ruleOf(floorProduct: Product, key: string | null): FloorDefault | null {
  const t = floorTypeOf(floorProduct);
  return (t && FLOOR_DEFAULTS[t]?.find((d) => d.key === key)) || null;
}

export type DefaultsAdded = { added: Line[]; notes: string[] };

/**
 * A measured floor line has just gone on an installation quote with its
 * install ticked: put its defaults on underneath. Each default once only.
 */
export async function applyFloorDefaults(floorId: number, product: Product): Promise<DefaultsAdded> {
  const out: DefaultsAdded = { added: [], notes: [] };
  const t = floorTypeOf(product);
  const defs = t ? FLOOR_DEFAULTS[t] : undefined;
  const start = await lineOf(floorId);
  if (!defs?.length || !start || start.measuredM2 == null) return out;
  if (!(await takesDefaults(start.quoteId))) return out;
  // 7 Nov: coving and welding only on a roll the price book marks commercial. Any other sheet vinyl waits for a decision.
  if (t === "sheet_vinyl" && !isCommercialSheet(product)) {
    // 7 Nov (second brief): wall vinyl is a verified type with nothing put on, so it is not flagged. Domestic sheet too (catalog decisions).
    if (!isWallVinyl(product) && !isDomesticSheet(product)) await flagLine(floorId, notCommercialFlag(product.tier));
    return out;
  }

  const done = new Set(appliedOf(start.defaultsApplied));
  const applied: string[] = [];
  const missing: string[] = [];
  for (const d of defs) {
    if (done.has(d.key)) continue;
    // Read fresh each time: every insert moves the lines below down one.
    const floor = await lineOf(floorId);
    if (!floor) break;

    if (d.type === "product") {
      const got = await liveProduct({ id: d.productId, sku: d.sku, name: d.name });
      if (!got.ok) {
        missing.push(got.why);
        continue;
      }
      const p = got.row;
      if (d.qty === "underlay") {
        // An underlay already following this floor stays as picked.
        const [has] = await db.select({ id: schema.quoteItems.id }).from(schema.quoteItems).where(eq(schema.quoteItems.followsItemId, floor.id));
        if (has) {
          applied.push(d.key);
          continue;
        }
        const s = await startLine(floor.quoteId, p, 1, floor.id);
        const unitPrice = await liveSellFor(p);
        const [row] = await db
          .insert(schema.quoteItems)
          .values({
            quoteId: floor.quoteId,
            productId: p.id,
            kind: "supply",
            lineType: "material",
            description: lineName(p),
            qty: s.qty,
            unit: p.unit,
            unitPrice,
            unitCost: p.costPrice ?? null,
            markupPercent: markupOf(p.costPrice, unitPrice),
            total: r2(s.qty * unitPrice),
            sortOrder: s.sortOrder ?? (await slotUnder(floor)),
            followsItemId: s.followsItemId ?? floor.id,
            flagged: Boolean(s.flag),
            flagReason: s.flag,
            floorCategory: floor.floorCategory,
            defaultForItemId: floor.id,
            defaultKey: d.key,
          })
          .returning();
        if (row) out.added.push(row);
      } else {
        const qty = autoQty(d.qty, floor, product, p) ?? 0;
        const unitPrice = await liveSellFor(p);
        const flag = qty > 0 ? null : enterFlag(`number of ${lineName(p)} sheets`);
        const row = await insertUnder(floor, d.key, {
          productId: p.id,
          kind: "supply",
          lineType: "material",
          description: lineName(p),
          qty,
          unit: p.unit,
          unitPrice,
          unitCost: p.costPrice ?? null,
          markupPercent: markupOf(p.costPrice, unitPrice),
          total: r2(qty * unitPrice),
          flagged: Boolean(flag),
          flagReason: flag,
        });
        if (row) out.added.push(row);
      }
      applied.push(d.key);
      continue;
    }

    const rate = await liveRate({ id: d.itemId, name: d.name });
    if (!rate.ok) {
      missing.push(rate.why);
      continue;
    }
    let qty = 0;
    let flag: string | null = null;
    if (d.qty === "enter") flag = enterFlag(d.what ?? d.name);
    if (d.itemId === RATE.trimInstall.id) {
      // A trim already on with its own install: say so, so the same length is not typed on both (7 Nov).
      const own = (await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, floor.quoteId))).filter(
        (l) => l.rateItemId === RATE.trimInstall.id && l.defaultKey === TRIM_KEY,
      );
      if (own.length) {
        const names = await Promise.all(own.map(areaNameOf));
        flag = `${flag ?? ""} ${trimOverlapFlag(names)}`.trim();
      }
    }
    else {
      qty = autoQty(d.qty, floor, product) ?? 0;
      if (d.qty === "uplift_lm" && qty <= 0) flag = UPLIFT_NO_WIDTH_FLAG;
      else if (qty <= 0) flag = enterFlag(d.what ?? `${d.name} qty`);
    }
    // Install trims/scotia: this area's own line, for this area's length only (7 Nov). Another area's line is a different length.
    let priced;
    try {
      priced = await standardLabour(d.itemId, qty);
    } catch (e) {
      missing.push(`${d.name} not put on. ${e instanceof Error ? e.message : ""}`.trim());
      continue;
    }
    const row = await insertUnder(floor, d.key, {
      ...priced.values,
      flagged: Boolean(flag),
      flagReason: flag,
      checkRequired: d.qty === "uplift_lm",
    });
    if (!row) continue;
    out.added.push(row);
    applied.push(d.key);
    if (d.itemId === RATE.carpetUplift.id) {
      const disposal = await ensureDisposal(row.id);
      if (disposal) out.added.push(disposal);
    }
  }
  await addApplied(floorId, applied);
  if (missing.length) {
    // On the line's flag, which the picker shows, so not in the notes as well.
    await flagLine(floorId, `Not put on by default: ${missing.join(" ")}`);
  }
  if (out.added.length) out.notes.unshift(`${out.added.length} default line${out.added.length === 1 ? "" : "s"} put on underneath. Remove any that are not needed.`);
  return out;
}

/**
 * A scotia or trim line has just gone on: Install trims/scotia goes under it,
 * unless the quote already has that install on (the laminate or hybrid
 * default, one typed in by hand, or another trim's). Then that line covers
 * it, and no second line is added.
 *
 * 7 Nov (second brief): the installed lm, when typed in with the trim, is
 * kept on the trim line and is what the install charges. The supplied
 * lengths never are. With no installed lm the install is flagged to enter.
 */
export async function applyTrimLabour(trimId: number, product: Product, installedLm: number | null = null): Promise<DefaultsAdded> {
  const out: DefaultsAdded = { added: [], notes: [] };
  const trim = await lineOf(trimId);
  if (!trim || !isTrimProduct(product)) return out;
  if (appliedOf(trim.defaultsApplied).includes(TRIM_KEY)) return out;
  if (!(await takesDefaults(trim.quoteId))) return out;
  const lm = installedLm != null && installedLm >= 0 ? r4(installedLm) : null;
  const own = lm != null ? [installedKey(lm)] : [];

  const installs = (await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, trim.quoteId)))
    .filter((l) => l.rateItemId === RATE.trimInstall.id && l.id !== trim.id)
    .sort((a, b) => b.sortOrder - a.sortOrder);
  if (installs.length) {
    // The nearest one above the trim: the area it was added in. With more than one area, the office picks (7 Nov).
    const cover = installs.find((l) => l.sortOrder < trim.sortOrder) ?? installs[0]!;
    await addApplied(trim.id, [TRIM_KEY, ...own, coveredKey(cover.id)]);
    const area = await areaNameOf(cover);
    const settled = await settleInstall(cover.id, { added: trim.id });
    if (installs.length > 1) {
      await flagLine(trim.id, TRIM_PICK_FLAG);
      out.notes.push(`Install covered by ${area}'s Install trims/scotia for now. More than one area has one, so pick the right area on the line.`);
    } else out.notes.push(`Install covered by ${area}'s Install trims/scotia already on the quote.`);
    out.notes.push(settled.note);
    return out;
  }
  const rate = await liveRate(RATE.trimInstall);
  let priced;
  try {
    if (!rate.ok) throw new Error(rate.why);
    priced = await standardLabour(RATE.trimInstall.id, lm ?? 0);
  } catch (e) {
    const why = `Install trims/scotia not put on. ${e instanceof Error ? e.message : ""}`.trim();
    await flagLine(trim.id, why);
    return out;
  }
  const row = await insertUnder(trim, TRIM_KEY, {
    ...priced.values,
    flagged: lm == null,
    flagReason: lm == null ? TRIM_FLAG : null,
    defaultsApplied: lm != null ? JSON.stringify([autoKey(lm)]) : null,
  });
  await addApplied(trim.id, [TRIM_KEY, ...own]);
  if (row) {
    out.added.push(row);
    out.notes.push(lm != null ? `${row.description} put on underneath at ${lm} lm installed.` : `${row.description} put on underneath. Enter the installed length.`);
  }
  return out;
}

/**
 * New skirting (Damien, 7 Nov): a Skirting product brings Install new
 * skirting straight under it, at the lm installed, or at 0 flagged to fill
 * in. One per skirting line, for that line's own run, so nothing is counted
 * twice. Removed with the line, and never put back once removed by hand.
 */
export async function applySkirtingLabour(lineId: number, product: Product, installedLm: number | null = null): Promise<DefaultsAdded> {
  const out: DefaultsAdded = { added: [], notes: [] };
  const line = await lineOf(lineId);
  if (!line || !isNewSkirting(product)) return out;
  if (appliedOf(line.defaultsApplied).includes(SKIRTING_KEY)) return out;
  if (!(await takesDefaults(line.quoteId))) return out;
  const lm = installedLm != null && installedLm >= 0 ? r4(installedLm) : null;
  const rate = await liveRate(RATE.newSkirting);
  let priced;
  try {
    if (!rate.ok) throw new Error(rate.why);
    priced = await standardLabour(RATE.newSkirting.id, lm ?? 0);
  } catch (e) {
    await flagLine(line.id, `${SKIRTING_MISSING_MARK} ${e instanceof Error ? e.message : ""}`.trim());
    return out;
  }
  const row = await insertUnder(line, SKIRTING_KEY, {
    ...priced.values,
    flagged: lm == null,
    flagReason: lm == null ? SKIRTING_FLAG : null,
  });
  await addApplied(line.id, [SKIRTING_KEY]);
  if (row) {
    out.added.push(row);
    out.notes.push(lm != null ? `${row.description} put on underneath at ${lm} lm installed.` : `${row.description} put on underneath. Enter the installed length.`);
  }
  return out;
}

/** The trims an Install trims/scotia line is for: the trim it was put on under, and every trim it covers. */
async function trimsOf(install: Line, exclude?: number) {
  const lines = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, install.quoteId));
  return lines.filter((l) => {
    if (l.id === exclude || l.id === install.id) return false;
    const applied = appliedOf(l.defaultsApplied);
    if (!applied.includes(TRIM_KEY)) return false;
    return coveredLineOf(applied) === install.id || (install.defaultKey === TRIM_KEY && install.defaultForItemId === l.id);
  });
}

/**
 * 7 Nov (second brief). An Install trims/scotia line after a trim was added
 * to it, moved off it or removed. While its length is still what this
 * feature set (or 0, never typed), it is the installed lm of the trims it is
 * for, added up. Once typed by hand it is kept exactly as typed, and the
 * office is asked to check it includes a trim just added. A trim with no
 * installed lm is never counted off its supplied lengths: it is flagged.
 */
export async function settleInstall(installId: number, opts: { added?: number; exclude?: number } = {}) {
  const install = await lineOf(installId);
  if (!install || install.rateItemId !== RATE.trimInstall.id) return { note: "" };
  const applied = appliedOf(install.defaultsApplied);
  const auto = autoOf(applied);
  const typed = auto == null ? install.qty > 0.0005 : !same(install.qty, auto);
  const trims = await trimsOf(install, opts.exclude);
  const added = opts.added != null ? trims.find((t) => t.id === opts.added) : undefined;
  if (typed) {
    // A trim that went elsewhere (or was removed) takes its own check sentence with it.
    const left = keepTrimAddedFor(install.flagReason, trims.map((t) => `"${t.description}"`));
    if (left !== install.flagReason) {
      await db
        .update(schema.quoteItems)
        .set({ flagged: Boolean(left), flagReason: left, updatedAt: new Date() })
        .where(eq(schema.quoteItems.id, install.id));
    }
    if (added) await flagLine(install.id, trimTypedFlag(`"${added.description}"`, installedOf(appliedOf(added.defaultsApplied))));
    return { note: "Its length was typed by hand, so it was kept. Check it includes this." };
  }
  const measured = trims.map((t) => installedOf(appliedOf(t.defaultsApplied)));
  const lm = r4(measured.reduce<number>((s, n) => s + (n ?? 0), 0));
  const missing = trims.filter((_, i) => measured[i] == null).map((t) => `"${t.description}"`);
  // Nothing measured yet: it stays at 0 with its own "enter the length" flag.
  if (!(lm > 0)) {
    // A length this feature set, with nothing left to count (trim moved or removed): back to 0, to fill in.
    if (auto != null) {
      const what = install.defaultKey === TRIM_KEY ? TRIM_FLAG : enterFlag(AREA_TRIM_WHAT);
      const rest = withoutTrimAdded(withoutEnterFlag(install.flagReason));
      const reason = rest ? `${what} ${rest}` : what;
      await db
        .update(schema.quoteItems)
        .set({
          qty: 0,
          total: 0,
          defaultsApplied: JSON.stringify(applied.filter((k) => !k.startsWith(`${TRIM_KEY}:auto:`))),
          flagged: true,
          flagReason: reason,
          ...(reason !== install.flagReason ? NOT_REVIEWED : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.quoteItems.id, install.id));
      return { note: "Enter the installed length on the Install trims/scotia line." };
    }
    if (missing.length && install.qty <= 0.0005 && !install.flagged) await flagLine(install.id, TRIM_FLAG);
    return { note: "Enter the installed length on the Install trims/scotia line." };
  }
  let reason = withoutTrimAdded(withoutEnterFlag(install.flagReason));
  if (missing.length) reason = reason ? `${reason} ${trimUnmeasuredFlag(missing)}` : trimUnmeasuredFlag(missing);
  const keys = [...applied.filter((k) => !k.startsWith(`${TRIM_KEY}:auto:`)), autoKey(lm)];
  const fresh = reason !== install.flagReason;
  await db
    .update(schema.quoteItems)
    .set({
      qty: lm,
      total: r2(lm * install.unitPrice),
      defaultsApplied: JSON.stringify(keys),
      flagged: Boolean(reason),
      flagReason: reason,
      ...(fresh && reason ? NOT_REVIEWED : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.quoteItems.id, install.id));
  return { note: `Install trims/scotia is now ${lm} lm installed.` };
}

/** What an Install trims/scotia line is for: its floor area or trim, or the line itself when typed in on its own. */
async function areaNameOf(install: Line) {
  const parent = install.defaultForItemId != null ? await lineOf(install.defaultForItemId) : null;
  return `"${(parent ?? install).description}"`;
}

/** The Install trims/scotia lines a trim on this quote can go with, each with the area it is for. */
export async function trimInstallChoices(quoteId: number) {
  const lines = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quoteId));
  const byId = new Map(lines.map((l) => [l.id, l]));
  return lines
    .filter((l) => l.rateItemId === RATE.trimInstall.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((l) => {
      const parent = l.defaultForItemId != null ? byId.get(l.defaultForItemId) : undefined;
      return { id: l.id, area: (parent ?? l).description, qty: l.qty };
    });
}

/**
 * The office picks which area's Install trims/scotia covers a trim (7 Nov).
 * Only the link moves: no line is added, no qty changes, nothing is charged
 * again. Clears the pick and install-removed warnings.
 */
export async function coverTrim(trimId: number, installId: number) {
  const trim = await lineOf(trimId);
  const install = await lineOf(installId);
  if (!trim || !install || install.quoteId !== trim.quoteId || install.rateItemId !== RATE.trimInstall.id) {
    throw new Error("Pick an Install trims/scotia line on this quote.");
  }
  const applied = appliedOf(trim.defaultsApplied);
  if (!applied.includes(TRIM_KEY)) throw new Error("This line is not a trim or scotia with an install.");
  const own = await db
    .select({ id: schema.quoteItems.id })
    .from(schema.quoteItems)
    .where(and(eq(schema.quoteItems.defaultForItemId, trim.id), eq(schema.quoteItems.defaultKey, TRIM_KEY)));
  if (own.length) throw new Error("This trim has its own Install trims/scotia line underneath it.");
  const was = coveredLineOf(applied);
  const keys = [...applied.filter((k) => !k.startsWith(`${TRIM_KEY}:covered:`)), coveredKey(install.id)];
  const left = stripWarnings(trim.flagReason, [TRIM_PICK_FLAG, TRIM_INSTALL_GONE_FLAG]);
  await db
    .update(schema.quoteItems)
    .set({ defaultsApplied: JSON.stringify(keys), flagged: Boolean(left), flagReason: left, updatedAt: new Date() })
    .where(eq(schema.quoteItems.id, trim.id));
  // 7 Nov (second brief): its installed lm moves with it, off the old area and onto the new one (never onto a length typed by hand).
  if (was !== install.id) {
    if (was != null) await settleInstall(was);
    await settleInstall(install.id, { added: trim.id });
  }
  return { area: await areaNameOf(install) };
}

/** A flag with some of its sentences taken out. Null when nothing is left. */
function stripWarnings(reason: string | null, drop: string[]) {
  let text = reason ?? "";
  for (const d of drop) text = text.split(d).join(" ");
  text = text.replace(/\s+/g, " ").trim();
  return text || null;
}

/**
 * A line just went on an installation quote with a product from a category
 * Damien's table covers, but the price book does not say box or roll. Its
 * defaults cannot be told, so it is flagged, not skipped quietly (7 Nov).
 */
export async function flagUnclassified(lineId: number, product: Product) {
  if (!needsClassifying(product)) return false;
  const line = await lineOf(lineId);
  if (!line || !(await takesDefaults(line.quoteId))) return false;
  await flagLine(lineId, unclassifiedFlag(lineName(product)));
  return true;
}

/* ------------------------------ carpet disposal ----------------------------- */

async function disposalRate() {
  const rows = await db
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, [DISPOSAL_COST_KEY, DISPOSAL_MARKUP_KEY]));
  const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const cost = settingNumber(kv[DISPOSAL_COST_KEY]);
  const pct = settingNumber(kv[DISPOSAL_MARKUP_KEY]);
  return cost != null && pct != null ? { cost, pct, sell: sellAtMarkup(cost, pct) } : null;
}

const widthOf = (fp: Product, floor: Line) => qtyForLine(fp, floor)?.widthM ?? fp.widthM ?? floor.rollWidthM ?? null;

/**
 * The roll width an uplift is measured off: its own carpet's, when it was put
 * on with one (by default, or as that carpet's install). One typed in on its
 * own takes the quote's carpet width, but only when every carpet on the
 * quote is the one width. Otherwise null, and the disposal is flagged.
 */
async function upliftWidth(uplift: Line): Promise<number | null> {
  const parentId = uplift.defaultForItemId ?? uplift.labourForItemId;
  if (parentId != null) {
    const floor = await lineOf(parentId);
    const fp = floor ? await productOf(floor.productId) : null;
    return floor && fp ? widthOf(fp, floor) : null;
  }
  const lines = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, uplift.quoteId));
  const widths = new Set<number>();
  for (const l of lines) {
    if (l.measuredM2 == null || l.productId == null) continue;
    const fp = await productOf(l.productId);
    if (!fp || floorTypeOf(fp) !== "carpet") continue;
    const w = widthOf(fp, l);
    if (w == null) return null;
    widths.add(r4(w));
  }
  return widths.size === 1 ? [...widths][0]! : null;
}

/** Disposal m2 = uplift lm x the roll width. Null when there is no width to work from. */
const disposalM2 = (upliftQty: number, width: number | null) => (width ? r2(upliftQty * width) : null);

/**
 * A Carpet uplift line is on: its disposal allowance goes under it, once.
 * Its own line per uplift, so separate areas each carry their own m2.
 * No rate in Settings or no m2 to work from: on at 0, flagged, so the quote
 * cannot go out with it unnoticed.
 */
export async function ensureDisposal(upliftId: number): Promise<Line | null> {
  const uplift = await lineOf(upliftId);
  if (!uplift || uplift.rateItemId !== RATE.carpetUplift.id) return null;
  if (appliedOf(uplift.defaultsApplied).includes(DISPOSAL_KEY)) return null;
  const [has] = await db
    .select({ id: schema.quoteItems.id })
    .from(schema.quoteItems)
    .where(and(eq(schema.quoteItems.defaultForItemId, uplift.id), eq(schema.quoteItems.defaultKey, DISPOSAL_KEY)));
  if (has) return null;
  if (!(await takesDefaults(uplift.quoteId))) return null;

  const rate = await disposalRate();
  const m2 = disposalM2(uplift.qty, await upliftWidth(uplift));
  const qty = m2 ?? 0;
  const flag = !rate ? DISPOSAL_NO_RATE_FLAG : !m2 ? DISPOSAL_NO_QTY_FLAG : null;
  const unitPrice = rate?.sell ?? 0;
  const row = await insertUnder(uplift, DISPOSAL_KEY, {
    kind: INTERNAL_CHARGE,
    lineType: "material",
    description: DISPOSAL_DESCRIPTION,
    qty,
    unit: "m2",
    unitPrice,
    unitCost: rate?.cost ?? null,
    markupPercent: rate?.pct ?? null,
    priceBy: rate ? "markup" : "",
    total: r2(qty * unitPrice),
    flagged: Boolean(flag),
    flagReason: flag,
  });
  await addApplied(uplift.id, [DISPOSAL_KEY]);
  return row;
}

/** The uplift lm moved: its disposal m2 follows, unless someone typed over the disposal. */
export async function followDisposal(upliftId: number) {
  const uplift = await lineOf(upliftId);
  if (!uplift) return 0;
  const width = await upliftWidth(uplift);
  const m2 = disposalM2(uplift.qty, width);
  if (m2 == null) return 0;
  const kids = await db
    .select()
    .from(schema.quoteItems)
    .where(and(eq(schema.quoteItems.defaultForItemId, uplift.id), eq(schema.quoteItems.defaultKey, DISPOSAL_KEY)));
  let moved = 0;
  for (const k of kids) {
    if (k.disposalTyped) continue;
    const flag =
      k.flagReason === DISPOSAL_NO_RATE_FLAG ? { flagged: true, flagReason: k.flagReason }
      : m2 > 0 ? (k.flagReason === DISPOSAL_NO_QTY_FLAG ? { flagged: false, flagReason: null } : {})
      : !k.flagged ? { flagged: true, flagReason: DISPOSAL_NO_QTY_FLAG }
      : {};
    if (same(k.qty, m2) && !("flagged" in flag)) continue;
    await db
      .update(schema.quoteItems)
      .set({ qty: m2, total: r2(m2 * k.unitPrice), ...flag, updatedAt: new Date() })
      .where(eq(schema.quoteItems.id, k.id));
    moved++;
  }
  return moved;
}

/**
 * A floor line's area, wastage or width changed: the defaults under it that
 * follow the area (skim, sanding, uplift, plywood) move with it. One someone
 * typed over (it no longer matches what the old figures gave) stays put.
 */
export async function followDefaults(before: Line, after: Line, product: Product) {
  const kids = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.defaultForItemId, after.id));
  let moved = 0;
  for (const k of kids) {
    const rule = ruleOf(product, k.defaultKey);
    if (!rule || rule.qty === "enter" || rule.qty === "underlay") continue;
    const dp = rule.type === "product" ? await productOf(k.productId) : null;
    const was = autoQty(rule.qty, before, product, dp);
    const now = autoQty(rule.qty, after, product, dp);
    if (now == null || was == null || !same(k.qty, was) || same(k.qty, now)) continue;
    const left = withoutEnterFlag(k.flagReason);
    const clear = now > 0 && isDefaultFlag(k.flagReason) ? { flagged: Boolean(left), flagReason: left } : {};
    await db
      .update(schema.quoteItems)
      .set({ qty: now, total: r2(now * k.unitPrice), ...clear, updatedAt: new Date() })
      .where(eq(schema.quoteItems.id, k.id));
    moved++;
    if (k.rateItemId === RATE.carpetUplift.id) await followDisposal(k.id);
  }
  // An uplift put on at 0 for want of a roll width is "what the old figures gave", so it moves once the width is in.
  // An uplift added as this carpet's install moved with it already (followLinkedLabour): its disposal follows.
  const asInstall = await db
    .select({ id: schema.quoteItems.id })
    .from(schema.quoteItems)
    .where(and(eq(schema.quoteItems.labourForItemId, after.id), eq(schema.quoteItems.rateItemId, RATE.carpetUplift.id)));
  for (const u of asInstall) moved += await followDisposal(u.id);
  return moved;
}

/**
 * A line's product was changed (Change product). Lines put on for the old
 * product stay as they are, as they may have been filled in, but any the new
 * product would not have had are flagged for review. The new floor type's own
 * defaults go on, except one already put on or removed before. A line that
 * has just become a trim or scotia gets its install as if added new.
 */
export async function afterProductChange(lineId: number, oldProduct: Product | null, product: Product) {
  const line = await lineOf(lineId);
  if (!line || !(await takesDefaults(line.quoteId))) return;
  const oldType = oldProduct ? floorTypeOf(oldProduct) : null;
  const newType = floorTypeOf(product);
  const wasTrim = Boolean(oldProduct && isTrimProduct(oldProduct));
  const nowTrim = isTrimProduct(product);
  const keep = new Set((newType ? (FLOOR_DEFAULTS[newType] ?? []) : []).map((d) => d.key));
  if (nowTrim) keep.add(TRIM_KEY);
  const wasSkirting = Boolean(oldProduct && isNewSkirting(oldProduct));
  const nowSkirting = isNewSkirting(product);
  if (nowSkirting) keep.add(SKIRTING_KEY);
  if (oldType !== newType || wasTrim !== nowTrim || wasSkirting !== nowSkirting) {
    const was = oldType ? FLOOR_TYPE_LABELS[oldType].toLowerCase() : wasTrim ? "trim or scotia" : wasSkirting ? "new skirting" : "old product";
    const now = newType ? FLOOR_TYPE_LABELS[newType].toLowerCase() : nowTrim ? "trim or scotia" : nowSkirting ? "new skirting" : lineName(product);
    const kids = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.defaultForItemId, lineId));
    for (const k of kids) {
      if (k.defaultKey && !keep.has(k.defaultKey))
        await db
          .update(schema.quoteItems)
          .set({ flagged: true, flagReason: changedFlag(was, now), ...NOT_REVIEWED, updatedAt: new Date() })
          .where(eq(schema.quoteItems.id, k.id));
    }
  }
  if (newType && oldType !== newType) await applyFloorDefaults(lineId, product);
  if (nowTrim && !wasTrim) await applyTrimLabour(lineId, product);
  if (nowSkirting && !wasSkirting) await applySkirtingLabour(lineId, product);
  if (!newType) await flagUnclassified(lineId, product);
}

/**
 * After a line was edited by hand:
 *  - a default's own "enter the length" flag clears once it has a qty;
 *  - a disposal typed over stops following its uplift;
 *  - an uplift's new lm moves its disposal.
 */
export async function afterLineEdit(before: Line, row: Line, typed: { qty?: number; unitPrice?: number; unitCost?: number | null }) {
  const qtyTyped = typed.qty !== undefined && !same(typed.qty, before.qty);
  const priceTyped =
    (typed.unitPrice !== undefined && typed.unitPrice !== before.unitPrice) ||
    (typed.unitCost !== undefined && typed.unitCost !== before.unitCost);

  if (row.defaultKey === DISPOSAL_KEY && row.kind === INTERNAL_CHARGE) {
    if (!qtyTyped && !priceTyped) return;
    const set: Partial<typeof schema.quoteItems.$inferInsert> = { disposalTyped: true };
    // A typed price or qty is what fills the gap the flag was about.
    if (row.flagReason === DISPOSAL_NO_RATE_FLAG && row.unitPrice > 0) {
      set.flagged = row.qty > 0 ? false : true;
      set.flagReason = row.qty > 0 ? null : DISPOSAL_NO_QTY_FLAG;
    } else if (row.flagReason === DISPOSAL_NO_QTY_FLAG && row.qty > 0) {
      set.flagged = false;
      set.flagReason = null;
    }
    await db.update(schema.quoteItems).set(set).where(eq(schema.quoteItems.id, row.id));
    return;
  }
  if (qtyTyped && row.qty > 0 && row.flagged && isDefaultFlag(row.flagReason)) {
    // Only the "enter the length" part comes off. Any other warning on the line stays (7 Nov).
    const left = withoutEnterFlag(row.flagReason);
    await db.update(schema.quoteItems).set({ flagged: Boolean(left), flagReason: left }).where(eq(schema.quoteItems.id, row.id));
  }
  if (qtyTyped && row.rateItemId === RATE.trimInstall.id) {
    // 7 Nov (second brief): a length typed by hand is the office's own. It is kept from now on, and its check-the-length warnings come off.
    const [now] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, row.id));
    if (now) {
      const left = withoutTrimAdded(now.flagReason);
      const keys = appliedOf(now.defaultsApplied).filter((k) => !k.startsWith(`${TRIM_KEY}:auto:`));
      await db
        .update(schema.quoteItems)
        .set({ flagged: Boolean(left), flagReason: left, defaultsApplied: keys.length ? JSON.stringify(keys) : null })
        .where(eq(schema.quoteItems.id, row.id));
    }
  }
  if (qtyTyped && row.rateItemId === RATE.carpetUplift.id) await followDisposal(row.id);
}

/**
 * A line is being removed. The defaults put on for it go with it, all the
 * way down, except a disposal allowance: that is left on, unlinked and
 * flagged, so nobody misses it. The key stays on its parent, so a removed
 * default never comes back.
 */
export async function removeDefaultsOf(lineId: number) {
  const gone: number[] = [];
  const flagged: number[] = [];
  const self = await lineOf(lineId);
  const quoteLines = self ? await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, self.quoteId)) : [];
  // The trims each Install trims/scotia covers (7 Nov), so removing an area never takes away an install another trim still needs.
  const coveredBy = (installId: number) => quoteLines.filter((l) => l.id !== lineId && coveredLineOf(appliedOf(l.defaultsApplied)) === installId);
  const kept: { id: number; reason: string }[] = [];
  let parents = [lineId];
  const seen = new Set<number>(parents);
  while (parents.length) {
    const kids = await db
      .select()
      .from(schema.quoteItems)
      .where(inArray(schema.quoteItems.defaultForItemId, parents));
    // Installs and underlay go with the line already (removeItem). An uplift added as one still leaves its disposal flagged.
    const linked = await db
      .select()
      .from(schema.quoteItems)
      .where(inArray(schema.quoteItems.labourForItemId, parents));
    const next: number[] = [];
    for (const k of [...kids, ...linked]) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      if (k.defaultKey === DISPOSAL_KEY && k.kind === INTERNAL_CHARGE) {
        flagged.push(k.id);
        continue;
      }
      const covers = k.rateItemId === RATE.trimInstall.id ? coveredBy(k.id) : [];
      if (covers.length) {
        const parent = quoteLines.find((l) => l.id === k.defaultForItemId) ?? self;
        kept.push({ id: k.id, reason: areaGoneFlag(`"${parent?.description ?? "floor"}"`, covers.map((c) => `"${c.description}"`)) });
        continue;
      }
      if (kids.includes(k)) gone.push(k.id);
      next.push(k.id);
    }
    parents = next;
  }
  if (flagged.length) {
    await db
      .update(schema.quoteItems)
      .set({ defaultForItemId: null, flagged: true, flagReason: DISPOSAL_ORPHAN_FLAG, ...NOT_REVIEWED, updatedAt: new Date() })
      .where(inArray(schema.quoteItems.id, flagged));
  }
  for (const k of kept) {
    await db.update(schema.quoteItems).set({ defaultForItemId: null, updatedAt: new Date() }).where(eq(schema.quoteItems.id, k.id));
    await flagLine(k.id, k.reason);
    await settleInstall(k.id, { exclude: lineId });
  }
  // 7 Nov (second brief): a trim taken off takes its installed lm off the install that covered it.
  const coveredBy0 = self ? coveredLineOf(appliedOf(self.defaultsApplied)) : null;
  if (coveredBy0 != null && !gone.includes(coveredBy0)) await settleInstall(coveredBy0, { exclude: lineId });
  // An Install trims/scotia removed by hand: the trims it covered are flagged, and moved to the nearest other install for now.
  let trimsFlagged = 0;
  if (self?.rateItemId === RATE.trimInstall.id) {
    const others = quoteLines
      .filter((l) => l.rateItemId === RATE.trimInstall.id && l.id !== lineId && !gone.includes(l.id))
      .sort((a, b) => b.sortOrder - a.sortOrder);
    for (const t of coveredBy(lineId)) {
      if (gone.includes(t.id)) continue;
      const next = others.find((o) => o.sortOrder < t.sortOrder) ?? others[0];
      const keys = appliedOf(t.defaultsApplied).filter((k) => !k.startsWith(`${TRIM_KEY}:covered:`));
      if (next) keys.push(coveredKey(next.id));
      await db.update(schema.quoteItems).set({ defaultsApplied: JSON.stringify(keys) }).where(eq(schema.quoteItems.id, t.id));
      await flagLine(t.id, TRIM_INSTALL_GONE_FLAG);
      if (next) await settleInstall(next.id, { added: t.id, exclude: lineId });
      trimsFlagged++;
    }
  }
  if (gone.length) await db.delete(schema.quoteItems).where(inArray(schema.quoteItems.id, gone));
  return { removedDefaults: gone.length, disposalFlagged: flagged.length, installsKept: kept.length, trimsFlagged };
}

/**
 * A new version or a copy of a quote: every default stays linked to its own
 * parent on the new lines, keeps which defaults were put on (so removed ones
 * stay removed), and keeps its "enter the length" flag.
 */
export async function copyDefaultLinks(items: Line[], newIdFor: Map<number, number | undefined>) {
  const remapKey = (k: string) => {
    const m = /^(trim:covered:)(\d+)$/.exec(k);
    if (!m) return k;
    const to = newIdFor.get(Number(m[2]));
    return to ? `${m[1]}${to}` : null;
  };
  for (const i of items) {
    const self = newIdFor.get(i.id);
    if (!self) continue;
    const parent = i.defaultForItemId != null ? newIdFor.get(i.defaultForItemId) : undefined;
    const applied = appliedOf(i.defaultsApplied)
      .map(remapKey)
      .filter((k): k is string => k != null);
    const keepFlag = i.flagged && isDefaultWarning(i.flagReason);
    const set: Partial<typeof schema.quoteItems.$inferInsert> = {};
    if (parent) set.defaultForItemId = parent;
    if (i.defaultKey) set.defaultKey = i.defaultKey;
    if (applied.length) set.defaultsApplied = JSON.stringify(applied);
    if (i.disposalTyped) set.disposalTyped = true;
    if (i.defaultReviewedBy) {
      set.defaultReviewedBy = i.defaultReviewedBy;
      set.defaultReviewedAt = i.defaultReviewedAt;
      set.defaultReviewNote = i.defaultReviewNote;
    }
    if (keepFlag) {
      set.flagged = true;
      set.flagReason = i.flagReason;
    }
    if (Object.keys(set).length) await db.update(schema.quoteItems).set(set).where(eq(schema.quoteItems.id, self));
  }
}

/**
 * Settings filled in after a disposal went on with no rate: price the
 * disposal lines still waiting on it, on quotes that can still change.
 */
export async function fillDisposalRates(quoteId: number) {
  const waiting = await db
    .select()
    .from(schema.quoteItems)
    .where(and(eq(schema.quoteItems.quoteId, quoteId), eq(schema.quoteItems.flagReason, DISPOSAL_NO_RATE_FLAG)));
  const lines = waiting.filter((l) => l.kind === INTERNAL_CHARGE && !l.disposalTyped);
  if (!lines.length || !(await takesDefaults(quoteId))) return 0;
  const rate = await disposalRate();
  if (!rate) return 0;
  for (const l of lines) {
    await db
      .update(schema.quoteItems)
      .set({
        unitPrice: rate.sell,
        unitCost: rate.cost,
        markupPercent: rate.pct,
        priceBy: "markup",
        total: r2(l.qty * rate.sell),
        flagged: l.qty > 0 ? false : true,
        flagReason: l.qty > 0 ? null : DISPOSAL_NO_QTY_FLAG,
        updatedAt: new Date(),
      })
      .where(eq(schema.quoteItems.id, l.id));
  }
  return lines.length;
}
