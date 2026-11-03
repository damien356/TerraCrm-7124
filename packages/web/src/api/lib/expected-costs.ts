import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { lineTypeOfKind } from "./line-kinds";
import { quoteRefById } from "./quote-number";

/* ---------------------------------------------------------------------------
 * 188001 fix list item 16. Money out is not empty any more.
 *
 * When a quote's work is made on a job (accept, or Convert to job), Terra
 * makes the expected costs from the quote's own cost prices:
 *
 *   one Materials cost per supplier   supply and accessory lines
 *   one Installer cost                labour, prep and removal lines
 *
 * Delivery lines are already an Other cost (lib/delivery-cost.ts).
 *
 * The rows carry source "quote" and state "budget", so they forecast as
 * expected. When a PO to that supplier is sent, the PO takes the row over
 * (lib/purchase-orders.ts commitPo). A later quote version updates the rows
 * still at budget and leaves the rest alone, telling the office.
 * ------------------------------------------------------------------------- */

export const QUOTE_SOURCE = "quote";
export const EXPECTED_NOTE = "Expected, from the quote's cost prices. A PO sent to this supplier replaces it.";
export const EXPECTED_LABOUR_NOTE = "Expected, from the quote's labour cost prices.";
export const EXPECTED_LOOSE_NOTE = "Expected, from the quote's cost prices. These lines have no supplier, so edit it by hand once you know who.";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type Line = { id: number; kind: string; description: string; qty: number; unitCost: number | null; supplierId: number | null; charge: boolean };
type Want = { kind: "materials" | "installer"; supplierId: number | null; description: string; amount: number; notes: string };

const keyOf = (kind: string, supplierId: number | null) => `${kind}:${supplierId ?? 0}`;

export const EXPECTED_STOCK_NOTE = "Part of this line comes from warehouse stock, so only the quantity still to order is expected here.";
export const CHARGES_DROPPED_NOTE = "Everything from this supplier comes from warehouse stock, so its quoted freight and charges are not expected.";

/**
 * What the quote says the job should cost, grouped the way Money out shows it.
 * `fromStock` (quote line id to quantity, A1.1) takes the quantity allocated
 * from warehouse stock off each line at the quote's rate. A supplier with
 * nothing left to order loses its freight and charge lines too.
 */
export async function expectedFromQuote(quoteId: number, fromStock: Map<number, number> = new Map()): Promise<Want[]> {
  const raw = await db
    .select({
      id: schema.quoteItems.id,
      kind: schema.quoteItems.kind,
      description: schema.quoteItems.description,
      qty: schema.quoteItems.qty,
      unitCost: schema.quoteItems.unitCost,
      supplierId: schema.products.supplierId,
      chargeSupplierId: schema.quoteItems.chargeSupplierId,
    })
    .from(schema.quoteItems)
    .leftJoin(schema.products, eq(schema.products.id, schema.quoteItems.productId))
    .where(eq(schema.quoteItems.quoteId, quoteId))
    .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
  // A supplier charge line (freight and the like) has no product, so it goes
  // with the supplier it was worked out for. That supplier's PO then replaces it.
  const items: Line[] = raw.map((r) => ({
    id: r.id,
    kind: r.kind,
    description: r.description,
    qty: Math.max(0, Math.round((r.qty - (fromStock.get(r.id) ?? 0)) * 10_000) / 10_000),
    unitCost: r.unitCost,
    supplierId: r.supplierId ?? r.chargeSupplierId ?? null,
    charge: !r.supplierId && !!r.chargeSupplierId,
  }));
  if (!items.length) return [];
  // A supplier whose goods all come from stock: nothing left to order, so no freight or charges.
  const goodsLeft = new Map<number, number>();
  const hadGoods = new Set<number>();
  for (const i of items) {
    if (i.charge || !i.supplierId || lineTypeOfKind(i.kind) !== "material") continue;
    hadGoods.add(i.supplierId);
    goodsLeft.set(i.supplierId, (goodsLeft.get(i.supplierId) ?? 0) + i.qty);
  }
  const allFromStock = new Set([...hadGoods].filter((id) => !(goodsLeft.get(id)! > 0.0001)));
  const touched = new Set(raw.filter((r) => (fromStock.get(r.id) ?? 0) > 0).map((r) => r.supplierId ?? 0));

  const ref = await quoteRefById(quoteId);
  const supIds = [...new Set(items.map((i) => i.supplierId).filter((x): x is number => !!x))];
  const names = new Map(
    supIds.length
      ? (await db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(inArray(schema.suppliers.id, supIds))).map(
          (s) => [s.id, s.name] as const,
        )
      : [],
  );

  const groups = new Map<string, { kind: Want["kind"]; supplierId: number | null; amount: number; noCost: number; lines: number }>();
  for (const i of items) {
    const type = lineTypeOfKind(i.kind);
    if (type === "delivery") continue;
    if (i.charge && i.supplierId && allFromStock.has(i.supplierId)) continue;
    if (type !== "labour" && !i.charge && i.supplierId && allFromStock.has(i.supplierId)) continue;
    const kind = type === "labour" ? "installer" : "materials";
    const supplierId = kind === "materials" ? (i.supplierId ?? null) : null;
    const k = keyOf(kind, supplierId);
    const g = groups.get(k) ?? { kind, supplierId, amount: 0, noCost: 0, lines: 0 };
    g.lines += 1;
    if (i.unitCost == null) g.noCost += 1;
    else g.amount += i.unitCost * i.qty;
    groups.set(k, g);
  }

  const out: Want[] = [];
  for (const g of groups.values()) {
    const who = g.kind === "installer" ? "Labour" : g.supplierId ? `Materials, ${names.get(g.supplierId) ?? "supplier"}` : "Materials, no supplier set";
    const gap = g.noCost ? ` ${g.noCost} of ${g.lines} line${g.lines === 1 ? " has" : "s have"} no cost price, so add ${g.noCost === 1 ? "it" : "them"}.` : "";
    out.push({
      kind: g.kind,
      supplierId: g.supplierId,
      description: `${who}, ${ref}`.slice(0, 300),
      amount: round2(g.amount),
      notes: (g.kind === "installer" ? EXPECTED_LABOUR_NOTE : g.supplierId ? EXPECTED_NOTE : EXPECTED_LOOSE_NOTE) + gap + (g.kind === "materials" && touched.has(g.supplierId ?? 0) ? ` ${EXPECTED_STOCK_NOTE}` : ""),
    });
  }
  // Said once per supplier, so the office sees why the expected cost went.
  for (const id of allFromStock) {
    if (!touched.has(id)) continue;
    out.push({ kind: "materials", supplierId: id, description: `Materials, ${names.get(id) ?? "supplier"}, ${ref}`.slice(0, 300), amount: 0, notes: CHARGES_DROPPED_NOTE });
  }
  // Materials first, then labour, as the cost card lists them.
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "materials" ? -1 : 1));
}

/** Suppliers with a PO on the job that has gone to them. Their expected cost is replaced. */
async function suppliersWithSentPo(jobId: number) {
  const rows = await db
    .select({ supplierId: schema.purchaseOrders.supplierId })
    .from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.jobId, jobId), inArray(schema.purchaseOrders.status, ["sent", "invoiced"])));
  return new Set(rows.map((r) => r.supplierId));
}

/**
 * Make the job's expected costs match the quote. Only rows Terra made and
 * still at budget are changed or removed. `onlySupplierId` limits it to one
 * supplier's materials, for a cancelled PO giving its expected cost back.
 */
export async function syncExpectedCosts(jobId: number, quoteId: number, opts: { onlySupplierId?: number } = {}) {
  const { stockAllocatedByQuoteItem } = await import("./stock/costs");
  let wants = await expectedFromQuote(quoteId, await stockAllocatedByQuoteItem(jobId));
  const sent = await suppliersWithSentPo(jobId);
  const only = opts.onlySupplierId;
  if (only != null) wants = wants.filter((w) => w.kind === "materials" && w.supplierId === only);
  // A supplier whose PO has gone out: the PO is the cost now.
  wants = wants.filter((w) => !(w.kind === "materials" && w.supplierId && sent.has(w.supplierId)));

  let rows = await db
    .select()
    .from(schema.jobCosts)
    .where(and(eq(schema.jobCosts.jobId, jobId), eq(schema.jobCosts.source, QUOTE_SOURCE)))
    .orderBy(asc(schema.jobCosts.id));
  if (only != null) rows = rows.filter((r) => r.kind === "materials" && r.supplierId === only);

  const byKey = new Map<string, (typeof rows)[number]>();
  const extra: typeof rows = [];
  for (const r of rows) {
    const k = keyOf(r.kind, r.kind === "materials" ? r.supplierId : null);
    if (byKey.has(k)) extra.push(r);
    else byKey.set(k, r);
  }

  const flags: string[] = [];
  const now = new Date();
  let added = 0;
  let changed = 0;
  let removed = 0;
  const money = (n: number) => `$${n.toFixed(2)}`;

  for (const w of wants) {
    const k = keyOf(w.kind, w.supplierId);
    const r = byKey.get(k);
    byKey.delete(k);
    if (!r) {
      await db.insert(schema.jobCosts).values({ jobId, ...w, state: "budget", source: QUOTE_SOURCE });
      added += 1;
      continue;
    }
    if (r.description === w.description && r.amount === w.amount && r.notes === w.notes) continue;
    if (r.state !== "budget") {
      if (r.amount !== w.amount) flags.push(`Cost "${r.description}" is ${r.state} at ${money(r.amount)}. The new quote has ${money(w.amount)}. Not changed.`);
      continue;
    }
    await db.update(schema.jobCosts).set({ description: w.description, amount: w.amount, notes: w.notes, updatedAt: now }).where(eq(schema.jobCosts.id, r.id));
    changed += 1;
  }
  for (const r of [...byKey.values(), ...extra]) {
    if (r.state !== "budget") {
      flags.push(`Cost "${r.description}" is not on the new quote but is ${r.state}. Kept.`);
      continue;
    }
    await db.delete(schema.jobCosts).where(eq(schema.jobCosts.id, r.id));
    removed += 1;
  }
  return { added, changed, removed, flags };
}

/** The supplier's expected cost on the job, for a sent PO to take over. */
export async function expectedCostFor(jobId: number, supplierId: number) {
  const [row] = await db
    .select()
    .from(schema.jobCosts)
    .where(
      and(
        eq(schema.jobCosts.jobId, jobId),
        eq(schema.jobCosts.source, QUOTE_SOURCE),
        eq(schema.jobCosts.kind, "materials"),
        eq(schema.jobCosts.supplierId, supplierId),
        eq(schema.jobCosts.state, "budget"),
      ),
    )
    .orderBy(asc(schema.jobCosts.id))
    .limit(1);
  return row ?? null;
}

/** The accepted quote on a job, newest version. */
export async function acceptedQuoteIdOf(jobId: number) {
  const [q] = await db
    .select({ id: schema.quotes.id })
    .from(schema.quotes)
    .where(and(eq(schema.quotes.jobId, jobId), eq(schema.quotes.status, "accepted")))
    .orderBy(desc(schema.quotes.version), desc(schema.quotes.id))
    .limit(1);
  return q?.id ?? null;
}
