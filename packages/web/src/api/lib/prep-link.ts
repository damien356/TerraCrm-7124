import { and, eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  appliedOf,
  followsAreaLabel,
  isAreaPrepItem,
  isPrepKey,
  m2Text,
  partialKey,
  partialOf,
  prepKey,
  prepMismatchFlag,
  prepPartialReviewFlag,
  prepPickFlag,
  withoutPrepFlags,
} from "./quote-default-rules";
import { slotUnder } from "./quote-sizes";

/*
 * Area prep on quotes (Damien, 10 Nov 2026, job 188016). Grinding and the
 * other m2 prep lines go with the floor area they are for and follow its
 * measured m2 (never the ordered m2 with waste). The link is the existing
 * quote defaults link (defaultForItemId, defaultKey "prep:<rate item>"), so
 * copies, revisions and reopening keep it. Three states:
 *
 *   follows   qty is the floor's measured m2, moves when the area changes
 *   partial   a smaller or larger area someone confirmed with a reason
 *             (who, when and why kept on the line and in the job history)
 *   open      a mismatch, or no floor picked: stops the quote going out
 *             through the quote defaults gate, like the other warnings
 *
 * Existing accepted quotes are never changed: this runs on add and edit only.
 */

type Line = typeof schema.quoteItems.$inferSelect;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const same = (a: number, b: number) => Math.abs(a - b) <= 0.0005;
const NOT_REVIEWED = { defaultReviewedBy: null, defaultReviewedAt: null, defaultReviewNote: null };

async function lineOf(id: number) {
  const [l] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, id));
  return l ?? null;
}

/** The rate book item behind a line when it is m2 area prep, else null. */
export async function prepItemOf(rateItemId: number | null | undefined) {
  if (rateItemId == null) return null;
  const [i] = await db
    .select({ id: schema.labourRateItems.id, name: schema.labourRateItems.name, unit: schema.labourRateItems.unit, groupName: schema.labourRateItems.groupName })
    .from(schema.labourRateItems)
    .where(eq(schema.labourRateItems.id, rateItemId));
  return i && isAreaPrepItem(i) ? i : null;
}

/** Floor lines on the quote with a measured area: the areas prep can follow. */
export async function measuredFloors(quoteId: number) {
  const lines = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quoteId));
  return lines.filter((l) => l.productId != null && l.lineType !== "labour" && l.measuredM2 != null && l.measuredM2 > 0);
}

/**
 * Where a new prep line goes when it is added by hand: under the one measured
 * floor, at its area. More than one floor (or none) is never guessed: it goes
 * on at 0 and asks which area.
 */
export async function prepPlan(quoteId: number, rateItemId: number, floorItemId?: number | null) {
  const item = await prepItemOf(rateItemId);
  if (!item) return null;
  const floors = await measuredFloors(quoteId);
  const floor = floorItemId != null ? (floors.find((f) => f.id === floorItemId) ?? null) : floors.length === 1 ? floors[0]! : null;
  if (floor) return { qty: floor.measuredM2!, floor, key: prepKey(item.id), flag: null as string | null };
  return { qty: 0, floor: null, key: prepKey(item.id), flag: prepPickFlag(item.name, floors.length) };
}

/** Put a newly added prep line under its floor. */
export async function placePrep(row: Line, floor: Line | null) {
  if (!floor) return;
  const sortOrder = await slotUnder(floor);
  await db.update(schema.quoteItems).set({ sortOrder }).where(eq(schema.quoteItems.id, row.id));
}

/**
 * Work out a prep line's warning from its link and qty, and write it. Other
 * warnings on the line are kept. A new warning needs dealing with again.
 */
export async function settlePrep(lineId: number) {
  const line = await lineOf(lineId);
  if (!line) return null;
  const item = await prepItemOf(line.rateItemId);
  // Only lines this links: a prep key, or no key of their own yet but under a floor. A floor default keeps its own rule.
  if (!item || (line.defaultKey != null && !isPrepKey(line.defaultKey)) || !(isPrepKey(line.defaultKey) || line.defaultForItemId != null)) return line;
  const applied = appliedOf(line.defaultsApplied);
  let partial = partialOf(applied);
  const floor = line.defaultForItemId != null ? await lineOf(line.defaultForItemId) : null;
  const area = floor?.measuredM2 != null && floor.measuredM2 > 0 ? floor.measuredM2 : null;
  let flag: string | null = null;
  if (area == null) {
    flag = prepPickFlag(item.name, (await measuredFloors(line.quoteId)).length);
  } else if (same(line.qty, area) && !partial) {
    flag = null;
  } else if (partial && same(partial.qty, line.qty)) {
    flag = same(partial.floorM2, area) ? null : prepPartialReviewFlag(item.name, partial.qty, partial.floorM2, area);
  } else {
    // A qty typed over a confirmed partial is not that partial any more.
    if (partial) partial = null;
    flag = same(line.qty, area) ? null : prepMismatchFlag(area, item.name, line.qty);
  }
  const keys = applied.filter((k) => !k.startsWith("prep:partial:"));
  if (partial) keys.push(partialKey(partial.qty, partial.floorM2));
  const base = withoutPrepFlags(line.flagReason);
  const text = [line.flagged ? base : null, flag].filter(Boolean).join(" ") || null;
  const fresh = flag != null && !(line.flagReason ?? "").includes(flag);
  const set = {
    flagged: Boolean(text),
    flagReason: text,
    defaultsApplied: keys.length ? JSON.stringify(keys) : null,
    ...(isPrepKey(line.defaultKey) ? {} : { defaultKey: prepKey(item.id) }),
    ...(fresh ? NOT_REVIEWED : {}),
  };
  const [row] = await db.update(schema.quoteItems).set(set).where(eq(schema.quoteItems.id, line.id)).returning();
  return row ?? line;
}

/** A floor's measured area changed: prep that followed the old area follows the new one. Partials stay, flagged when questionable. */
export async function followPrepArea(before: Line, after: Line) {
  const kids = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.defaultForItemId, after.id));
  let moved = 0;
  for (const k of kids) {
    if (!isPrepKey(k.defaultKey) || !(await prepItemOf(k.rateItemId))) continue;
    const partial = partialOf(appliedOf(k.defaultsApplied));
    const followed = before.measuredM2 != null && same(k.qty, before.measuredM2);
    if (!partial && followed && after.measuredM2 != null && after.measuredM2 > 0 && !same(k.qty, after.measuredM2)) {
      const qty = after.measuredM2;
      await db.update(schema.quoteItems).set({ qty, total: r2(qty * k.unitPrice), updatedAt: new Date() }).where(eq(schema.quoteItems.id, k.id));
      moved++;
    }
    await settlePrep(k.id);
  }
  return moved;
}

/** Follow the floor's measured area (and pick the floor). Clears a partial. */
export async function followArea(lineId: number, floorItemId?: number | null) {
  const line = await lineOf(lineId);
  if (!line) throw new Error("Line not found.");
  const item = await prepItemOf(line.rateItemId);
  if (!item) throw new Error("Only m2 preparation lines follow a floor area.");
  const floors = await measuredFloors(line.quoteId);
  const floorId = floorItemId ?? line.defaultForItemId ?? (floors.length === 1 ? floors[0]!.id : null);
  const floor = floors.find((f) => f.id === floorId);
  if (!floor) throw new Error(floors.length ? "Pick the floor area this is for." : "No floor line on this quote has a measured area yet.");
  const qty = floor.measuredM2!;
  const keys = appliedOf(line.defaultsApplied).filter((k) => !k.startsWith("prep:partial:"));
  const moved = line.defaultForItemId !== floor.id;
  await db
    .update(schema.quoteItems)
    .set({
      defaultForItemId: floor.id,
      defaultKey: prepKey(item.id),
      qty,
      total: r2(qty * line.unitPrice),
      defaultsApplied: keys.length ? JSON.stringify(keys) : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.quoteItems.id, line.id));
  if (moved) await placePrep(line, floor);
  const row = await settlePrep(line.id);
  return { row, floor, item, was: line.qty, qty };
}

/** A genuine partial area: a confirmed qty and a reason, kept with who and when. */
export async function confirmPartial(lineId: number, qty: number, reason: string, by: string, floorItemId?: number | null) {
  const line = await lineOf(lineId);
  if (!line) throw new Error("Line not found.");
  const item = await prepItemOf(line.rateItemId);
  if (!item) throw new Error("Only m2 preparation lines take a partial area.");
  if (!(qty > 0)) throw new Error("Enter the partial area in m2.");
  const why = reason.trim();
  if (why.length < 3) throw new Error("Give a short reason for the partial area.");
  const floors = await measuredFloors(line.quoteId);
  const floorId = floorItemId ?? line.defaultForItemId ?? (floors.length === 1 ? floors[0]!.id : null);
  const floor = floors.find((f) => f.id === floorId);
  if (!floor) throw new Error(floors.length ? "Pick the floor area this is part of." : "Enter the floor's measured m2 first.");
  const keys = appliedOf(line.defaultsApplied).filter((k) => !k.startsWith("prep:partial:"));
  keys.push(partialKey(qty, floor.measuredM2!));
  const at = new Date();
  await db
    .update(schema.quoteItems)
    .set({
      defaultForItemId: floor.id,
      defaultKey: prepKey(item.id),
      qty,
      total: r2(qty * line.unitPrice),
      defaultsApplied: JSON.stringify(keys),
      flagReason: withoutPrepFlags(line.flagReason),
      defaultReviewedBy: by,
      defaultReviewedAt: at,
      defaultReviewNote: `Partial area ${m2Text(qty)} of ${m2Text(floor.measuredM2!)}: ${why}`.slice(0, 500),
      updatedAt: at,
    })
    .where(eq(schema.quoteItems.id, line.id));
  if (line.defaultForItemId !== floor.id) await placePrep(line, floor);
  const row = await settlePrep(line.id);
  return { row, floor, item, was: line.qty, qty, reason: why };
}

/** What the builder shows under each prep line. Read only. */
export async function prepLinks(quoteId: number) {
  const lines = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quoteId));
  const floors = lines.filter((l) => l.productId != null && l.lineType !== "labour" && l.measuredM2 != null && l.measuredM2 > 0);
  const bundles = await db.select({ wording: schema.quoteBundles.wording }).from(schema.quoteBundles).where(eq(schema.quoteBundles.quoteId, quoteId));
  const out: Array<{
    id: number;
    name: string;
    floorId: number | null;
    floorName: string | null;
    floorM2: number | null;
    mode: "follows" | "partial" | "open" | "unlinked";
    label: string | null;
    wordingNote: string | null;
  }> = [];
  for (const l of lines) {
    const item = await prepItemOf(l.rateItemId);
    if (!item) continue;
    const floor = l.defaultForItemId != null ? (floors.find((f) => f.id === l.defaultForItemId) ?? null) : null;
    const partial = partialOf(appliedOf(l.defaultsApplied));
    const linked = isPrepKey(l.defaultKey) || l.defaultForItemId != null;
    const area = floor?.measuredM2 ?? null;
    const mode = !linked ? "unlinked" : area != null && same(l.qty, area) && !partial ? "follows" : partial && same(partial.qty, l.qty) && area != null && same(partial.floorM2, area) ? "partial" : "open";
    out.push({
      id: l.id,
      name: item.name,
      floorId: floor?.id ?? null,
      floorName: floor?.description ?? null,
      floorM2: area,
      mode,
      label: mode === "follows" && area != null ? followsAreaLabel(area) : mode === "partial" && area != null ? `Partial area: ${m2Text(l.qty)} of ${m2Text(area)}` : null,
      wordingNote: wordingClash([l.description, ...bundles.map((b) => b.wording)], item.name, l.qty),
    });
  }
  return { floors: floors.map((f) => ({ id: f.id, name: f.description, m2: f.measuredM2! })), lines: out };
}

/**
 * The customer wording names a different area for this work, where that can
 * be read plainly ("50 m2 ... grinding" in one sentence). A note only: nothing
 * is changed, and wording that can't be read plainly says nothing.
 */
export function wordingClash(texts: string[], name: string, qty: number): string | null {
  const word = name.trim().split(/\s+/)[0]!.toLowerCase();
  if (word.length < 4) return null;
  const found = new Set<number>();
  for (const t of texts) {
    for (const sentence of (t ?? "").split(/(?<=[.!?\n])\s*/)) {
      if (!sentence.toLowerCase().includes(word)) continue;
      for (const m of sentence.matchAll(/(\d+(?:\.\d+)?)\s*(?:m2|m²|sqm|square met)/gi)) found.add(Number(m[1]));
    }
  }
  if (!found.size || [...found].some((n) => same(n, qty))) return null;
  return `Customer wording says ${[...found].map(m2Text).join(" / ")} for ${name.toLowerCase()}, but the line is ${m2Text(qty)}. Check which is right. Nothing was changed.`;
}

/** A floor line with prep under it, for the activity log wording. */
export async function floorName(floorId: number) {
  const [f] = await db.select({ d: schema.quoteItems.description }).from(schema.quoteItems).where(and(eq(schema.quoteItems.id, floorId)));
  return f?.d ?? "the floor";
}

/** Its floor line is being removed: the prep line stays, unlinked, and asks which area it is for. */
export async function leavePrep(line: Line, goneFloorId: number) {
  const item = await prepItemOf(line.rateItemId);
  const left = (await measuredFloors(line.quoteId)).filter((f) => f.id !== goneFloorId).length;
  const flag = prepPickFlag(item?.name ?? line.description, left);
  const base = withoutPrepFlags(line.flagReason);
  const keys = appliedOf(line.defaultsApplied).filter((k) => !k.startsWith("prep:partial:"));
  await db
    .update(schema.quoteItems)
    .set({
      defaultForItemId: null,
      flagged: true,
      flagReason: [line.flagged ? base : null, flag].filter(Boolean).join(" "),
      defaultsApplied: keys.length ? JSON.stringify(keys) : null,
      ...NOT_REVIEWED,
      updatedAt: new Date(),
    })
    .where(eq(schema.quoteItems.id, line.id));
}
