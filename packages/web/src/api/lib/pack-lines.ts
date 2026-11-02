/**
 * Pack name (Damien, 2 Nov), on quote lines. The words and sums live in
 * pack-name.ts and order-sizes.ts. This file writes lines.
 *
 * A sheet underlay (SureBoard Wet) gets its install on automatically, linked
 * to the underlay line, at the m2 of the sheets on that line: 10 sheets of
 * 1.08 m2 is 10.8 m2 of install at $20/m2. It moves when the sheets move,
 * unless someone typed over the install qty.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { boxM2Of } from "./flooring-qty";
import { isSheetUnderlay, SHEET_UNDERLAY_INSTALL_NAME } from "./pack-name";
import { addLinkedLabour } from "./quote-labour";

type Product = typeof schema.products.$inferSelect;
type Line = typeof schema.quoteItems.$inferSelect;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const same = (a: number, b: number) => Math.abs(a - b) <= 0.0005;

/** Install m2 for a sheet underlay line: the m2 of the sheets on it. */
export function packLabourQty(p: Pick<Product, "unit" | "unitsPerPack" | "unitM2" | "packM2Printed">, lineQty: number): number {
  if (p.unit === "m2") return r4(lineQty);
  const m2 = boxM2Of(p as Product);
  return m2 ? r4(lineQty * m2) : r4(lineQty);
}

/** The rate book id of the sheet underlay install, or null when it is not in the rate book. */
export async function sheetInstallId(): Promise<number | null> {
  const [row] = await db
    .select({ id: schema.labourRateItems.id })
    .from(schema.labourRateItems)
    .where(and(sql`lower(${schema.labourRateItems.name}) = ${SHEET_UNDERLAY_INSTALL_NAME.toLowerCase()}`, eq(schema.labourRateItems.active, true)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Put the sheet underlay install under a sheet underlay line, unless it has
 * one already or the quote already carries that install on its own (said on
 * a voice quote). A missing rate flags the line instead, the line itself stays.
 */
export async function ensurePackInstall(line: Line, product: Product) {
  if (!isSheetUnderlay(product)) return null;
  const [linked] = await db
    .select({ id: schema.quoteItems.id })
    .from(schema.quoteItems)
    .where(eq(schema.quoteItems.labourForItemId, line.id));
  if (linked) return null;
  const itemId = await sheetInstallId();
  if (itemId == null) {
    await db
      .update(schema.quoteItems)
      .set({ flagged: true, flagReason: `Install not added. "${SHEET_UNDERLAY_INSTALL_NAME}" is not in the rate book.`, updatedAt: new Date() })
      .where(eq(schema.quoteItems.id, line.id));
    return null;
  }
  const [said] = await db
    .select({ id: schema.quoteItems.id })
    .from(schema.quoteItems)
    .where(
      and(
        eq(schema.quoteItems.quoteId, line.quoteId),
        eq(schema.quoteItems.rateItemId, itemId),
        isNull(schema.quoteItems.labourForItemId),
      ),
    );
  if (said) return null;
  try {
    return await addLinkedLabour({ ...line, qty: packLabourQty(product, line.qty) }, product, itemId);
  } catch (e) {
    await db
      .update(schema.quoteItems)
      .set({ flagged: true, flagReason: `Install not added. ${e instanceof Error ? e.message : ""}`.trim(), updatedAt: new Date() })
      .where(eq(schema.quoteItems.id, line.id));
    return null;
  }
}

/** The sheets on a sheet underlay line moved: its install follows, unless it was typed over. */
export async function followPackLabour(lineId: number, up: Product, oldQty: number, newQty: number) {
  if (!isSheetUnderlay(up)) return 0;
  const linked = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.labourForItemId, lineId));
  const was = packLabourQty(up, oldQty);
  const now = packLabourQty(up, newQty);
  let moved = 0;
  for (const l of linked) {
    if (l.unit !== "m2" || !same(l.qty, was) || same(l.qty, now)) continue;
    await db
      .update(schema.quoteItems)
      .set({ qty: now, total: round2(now * l.unitPrice), updatedAt: new Date() })
      .where(eq(schema.quoteItems.id, l.id));
    moved++;
  }
  return moved;
}
