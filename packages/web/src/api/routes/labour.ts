import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, authed, installerOnly } from "../middleware/auth";
import { sellExGstWithMarkup } from "../lib/pricing";

/**
 * THE LABOUR RATE BOOK.
 *
 * Three rules this file exists to enforce:
 *
 *  1. INHERITANCE. Terra has one default rate per work item. An installer with
 *     no rate of his own follows it, and is never given a copy. Change Terra's
 *     number and everyone who has not been overridden moves with it.
 *
 *  2. HISTORY. A rate is never edited in place. Setting a new one closes the
 *     old row off with an effectiveTo of the day before, so a job costed last
 *     year still reads back at last year's rate.
 *
 *  3. PRIVACY. An installer can read his own rates and nothing else. Not
 *     Terra's default, not another installer's card, not the sell price, not
 *     the margin. That is enforced here, on the server, not in the UI.
 */

const UNITS = ["m2", "lm", "each", "step", "hour", "day", "job", "percent", "km"] as const;
const GROUPS = ["carpet", "resilient", "timber", "prep", "demolition", "trades", "surcharge", "other"] as const;
const KINDS = ["work", "surcharge", "allowance"] as const;

const today = () => new Date().toISOString().slice(0, 10);

/** YYYY-MM-DD, one day before the given date. Used to close off the old rate. */
function dayBefore(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export type ResolvedRate = {
  amount: number | null;
  minimumCharge: number | null;
  /** installer = his own rate · terra = the default · none = nobody has priced it */
  source: "installer" | "terra" | "none";
  effectiveFrom: string | null;
  rateId: number | null;
};

/**
 * What an item pays on a given day. Installer rate wins, Terra default is the
 * fallback, and a missing rate is reported rather than guessed at zero.
 */
function pick(rows: RateRow[], itemId: number, installerId: number | null, on: string): ResolvedRate {
  const live = (r: RateRow) => r.effectiveFrom <= on && (!r.effectiveTo || r.effectiveTo >= on);
  const forItem = rows.filter((r) => r.itemId === itemId && live(r));
  const own = installerId
    ? forItem.filter((r) => r.installerId === installerId).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
    : undefined;
  const std = forItem.filter((r) => r.installerId === null).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  const hit = own ?? std;
  if (!hit) return { amount: null, minimumCharge: null, source: "none", effectiveFrom: null, rateId: null };
  return {
    amount: hit.amount,
    minimumCharge: hit.minimumCharge,
    source: own ? "installer" : "terra",
    effectiveFrom: hit.effectiveFrom,
    rateId: hit.id,
  };
}

type RateRow = typeof schema.labourRates.$inferSelect;

/** Every rate row in play for a set of items. Small table, one read is fine. */
async function loadRates(itemIds?: number[]) {
  if (itemIds && itemIds.length === 0) return [];
  const q = db.select().from(schema.labourRates);
  return itemIds ? await q.where(inArray(schema.labourRates.itemId, itemIds)) : await q;
}

/**
 * Write a new rate, closing the previous one off instead of overwriting it.
 * Same-day change replaces that day's row, so a typo fixed five minutes later
 * does not leave a one day rate in the history.
 */
async function writeRate(args: {
  itemId: number;
  installerId: number | null;
  amount: number;
  minimumCharge: number | null;
  effectiveFrom: string;
  note: string | null;
  actorName: string;
}) {
  const where = and(
    eq(schema.labourRates.itemId, args.itemId),
    args.installerId == null
      ? isNull(schema.labourRates.installerId)
      : eq(schema.labourRates.installerId, args.installerId),
  );
  const existing = await db.select().from(schema.labourRates).where(where);

  const sameDay = existing.find((r) => r.effectiveFrom === args.effectiveFrom);
  if (sameDay) {
    const [row] = await db
      .update(schema.labourRates)
      .set({
        amount: args.amount,
        minimumCharge: args.minimumCharge,
        note: args.note,
        createdByName: args.actorName,
        updatedAt: new Date(),
      })
      .where(eq(schema.labourRates.id, sameDay.id))
      .returning();
    return row!;
  }

  // Anything currently open that starts before the new rate gets an end date.
  const closeOff = existing.filter((r) => !r.effectiveTo && r.effectiveFrom < args.effectiveFrom);
  for (const r of closeOff) {
    await db
      .update(schema.labourRates)
      .set({ effectiveTo: dayBefore(args.effectiveFrom), updatedAt: new Date() })
      .where(eq(schema.labourRates.id, r.id));
  }

  const [row] = await db
    .insert(schema.labourRates)
    .values({
      itemId: args.itemId,
      installerId: args.installerId,
      amount: args.amount,
      minimumCharge: args.minimumCharge,
      effectiveFrom: args.effectiveFrom,
      note: args.note,
      createdByName: args.actorName,
    })
    .returning();
  return row!;
}

export const labour = {
  /* ------------------------------------------------------------------ *
   * Terra's rate book
   * ------------------------------------------------------------------ */

  /** The whole book with today's rate on each item, for the Settings tab. */
  book: adminOnly
    .input(
      z
        .object({
          on: z.string().optional(),
          search: z.string().optional(),
          includeInactive: z.boolean().default(false),
        })
        .default({ includeInactive: false }),
    )
    .handler(async ({ input }) => {
      const on = input.on ?? today();
      const [items, rates, skillRows] = await Promise.all([
        db
          .select()
          .from(schema.labourRateItems)
          .orderBy(asc(schema.labourRateItems.sortOrder), asc(schema.labourRateItems.name)),
        loadRates(),
        db.select({ id: schema.skills.id, name: schema.skills.name }).from(schema.skills),
      ]);
      const skillName = new Map(skillRows.map((s) => [s.id, s.name]));
      const needle = (input.search ?? "").trim().toLowerCase();

      const rows = items
        .filter((i) => (input.includeInactive ? true : i.active))
        .filter((i) => (needle ? `${i.name} ${skillName.get(i.skillId ?? -1) ?? ""}`.toLowerCase().includes(needle) : true))
        .map((i) => {
          const std = pick(rates, i.id, null, on);
          return {
            ...i,
            skillName: i.skillId ? (skillName.get(i.skillId) ?? null) : null,
            rate: std.amount,
            minimumCharge: std.minimumCharge,
            effectiveFrom: std.effectiveFrom,
            /** How many installers are on their own number for this item. */
            overrides: new Set(
              rates.filter((r) => r.itemId === i.id && r.installerId != null && !r.effectiveTo).map((r) => r.installerId),
            ).size,
          };
        });

      return {
        on,
        rows,
        priced: rows.filter((r) => r.rate != null).length,
        units: UNITS,
        groups: GROUPS,
      };
    }),

  /** Every version of one item's rate, Terra's and each installer's. */
  history: adminOnly
    .input(z.object({ itemId: z.number(), installerId: z.number().nullable().default(null) }))
    .handler(async ({ input }) => {
      const rows = await db
        .select({
          rate: schema.labourRates,
          installerName: schema.installers.name,
        })
        .from(schema.labourRates)
        .leftJoin(schema.installers, eq(schema.installers.id, schema.labourRates.installerId))
        .where(
          and(
            eq(schema.labourRates.itemId, input.itemId),
            input.installerId == null
              ? undefined
              : eq(schema.labourRates.installerId, input.installerId),
          ),
        )
        .orderBy(desc(schema.labourRates.effectiveFrom), desc(schema.labourRates.id));

      return rows.map((r) => ({
        ...r.rate,
        who: r.installerName ?? "Terra standard",
        current: !r.rate.effectiveTo,
      }));
    }),

  itemCreate: adminOnly
    .input(
      z.object({
        name: z.string().min(1),
        skillId: z.number().nullable().default(null),
        groupName: z.enum(GROUPS).default("other"),
        kind: z.enum(KINDS).default("work"),
        unit: z.enum(UNITS).default("m2"),
        /**
         * Null (the normal case) = the standard markup chain, 91.1%. Set it
         * only on an item that genuinely prices differently, which today means
         * disposal and tip runs going out at cost plus 15%.
         */
        markupPercent: z.number().min(0).nullable().default(null),
        notes: z.string().nullable().default(null),
      }),
    )
    .handler(async ({ input }) => {
      const [{ max }] = await db
        .select({ max: sql<number>`coalesce(max(sort_order), 0)` })
        .from(schema.labourRateItems);
      const [row] = await db
        .insert(schema.labourRateItems)
        .values({ ...input, sortOrder: (max ?? 0) + 1 })
        .returning();
      return row;
    }),

  itemUpdate: adminOnly
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        skillId: z.number().nullable().optional(),
        groupName: z.enum(GROUPS).optional(),
        kind: z.enum(KINDS).optional(),
        unit: z.enum(UNITS).optional(),
        /** Pass null to put the item back on the standard chain. */
        markupPercent: z.number().min(0).nullable().optional(),
        notes: z.string().nullable().optional(),
        sortOrder: z.number().optional(),
        active: z.boolean().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.labourRateItems)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.labourRateItems.id, id))
        .returning();
      return row;
    }),

  /**
   * Delete a rate item from Settings. Old quotes keep their own copy of the
   * words and price, so they never change. An item already measured on a job
   * task is switched off instead, because deleting it would take those
   * measured lines off the job with it. Switched off items stay findable
   * under "Show switched off" and can be turned back on.
   */
  itemDelete: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [item] = await db.select().from(schema.labourRateItems).where(eq(schema.labourRateItems.id, input.id));
    if (!item) return { result: "gone" as const, onJobs: 0 };
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.taskLabourLines)
      .where(eq(schema.taskLabourLines.itemId, input.id));
    const onJobs = Number(n ?? 0);
    if (onJobs > 0) {
      await db
        .update(schema.labourRateItems)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(schema.labourRateItems.id, input.id));
      return { result: "switched_off" as const, onJobs };
    }
    await db.delete(schema.labourRateItems).where(eq(schema.labourRateItems.id, input.id));
    return { result: "deleted" as const, onJobs: 0 };
  }),

  /**
   * Set a rate. No installerId = Terra's default, which every installer without
   * their own number follows from that date.
   */
  setRate: adminOnly
    .input(
      z.object({
        itemId: z.number(),
        installerId: z.number().nullable().default(null),
        amount: z.number().min(0),
        minimumCharge: z.number().min(0).nullable().default(null),
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        note: z.string().nullable().default(null),
      }),
    )
    .handler(async ({ input, context }) => {
      return await writeRate({
        itemId: input.itemId,
        installerId: input.installerId,
        amount: input.amount,
        minimumCharge: input.minimumCharge,
        effectiveFrom: input.effectiveFrom ?? today(),
        note: input.note,
        actorName: context.actor.name,
      });
    }),

  /** Several rates in one go, all off the same effective date. */
  setRates: adminOnly
    .input(
      z.object({
        installerId: z.number().nullable().default(null),
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        note: z.string().nullable().default(null),
        rates: z
          .array(z.object({ itemId: z.number(), amount: z.number().min(0), minimumCharge: z.number().min(0).nullable().default(null) }))
          .min(1)
          .max(300),
      }),
    )
    .handler(async ({ input, context }) => {
      const from = input.effectiveFrom ?? today();
      for (const r of input.rates) {
        await writeRate({
          itemId: r.itemId,
          installerId: input.installerId,
          amount: r.amount,
          minimumCharge: r.minimumCharge,
          effectiveFrom: from,
          note: input.note,
          actorName: context.actor.name,
        });
      }
      return { written: input.rates.length, effectiveFrom: from };
    }),

  /**
   * Drop an installer's override so he goes back to following Terra's default.
   * The history stays: the old row is closed off, not deleted.
   */
  clearOverride: adminOnly
    .input(
      z.object({
        itemId: z.number(),
        installerId: z.number(),
        /** The day he goes back on the standard rate. */
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    )
    .handler(async ({ input }) => {
      const from = input.effectiveFrom ?? today();
      const rows = await db
        .select()
        .from(schema.labourRates)
        .where(
          and(
            eq(schema.labourRates.itemId, input.itemId),
            eq(schema.labourRates.installerId, input.installerId),
          ),
        );
      let closed = 0;
      for (const r of rows) {
        if (r.effectiveTo) continue;
        if (r.effectiveFrom >= from) {
          // Never started, or starts on the day it is being removed. Bin it.
          await db.delete(schema.labourRates).where(eq(schema.labourRates.id, r.id));
        } else {
          await db
            .update(schema.labourRates)
            .set({ effectiveTo: dayBefore(from), updatedAt: new Date() })
            .where(eq(schema.labourRates.id, r.id));
        }
        closed++;
      }
      return { closed, effectiveFrom: from };
    }),

  /* ------------------------------------------------------------------ *
   * One installer's card
   * ------------------------------------------------------------------ */

  /**
   * The rate card: every item under a skill he's ticked for, with Terra's
   * standard, his own if he has one, and the difference.
   */
  card: adminOnly
    .input(
      z.object({
        installerId: z.number(),
        on: z.string().optional(),
        /** Off by default: the card shows what he can actually be sent to. */
        allItems: z.boolean().default(false),
      }),
    )
    .handler(async ({ input }) => {
      const on = input.on ?? today();
      const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, input.installerId));
      if (!installer) throw new Error("No such installer");

      const [items, rates, ticks, acks] = await Promise.all([
        db
          .select()
          .from(schema.labourRateItems)
          .where(eq(schema.labourRateItems.active, true))
          .orderBy(asc(schema.labourRateItems.sortOrder)),
        loadRates(),
        db
          .select({ skillId: schema.installerSkills.skillId })
          .from(schema.installerSkills)
          .where(eq(schema.installerSkills.installerId, input.installerId)),
        db
          .select()
          .from(schema.rateAcknowledgements)
          .where(eq(schema.rateAcknowledgements.installerId, input.installerId)),
      ]);

      const ticked = new Set(ticks.map((t) => t.skillId));
      const rows = items
        // Surcharges and allowances aren't tied to a trade, so they always show.
        .filter((i) => input.allItems || i.skillId == null || ticked.has(i.skillId))
        .map((i) => {
          const standard = pick(rates, i.id, null, on);
          const mine = pick(rates, i.id, input.installerId, on);
          return {
            itemId: i.id,
            name: i.name,
            groupName: i.groupName,
            kind: i.kind,
            unit: i.unit,
            skillId: i.skillId,
            standard: standard.amount,
            rate: mine.amount,
            minimumCharge: mine.minimumCharge,
            custom: mine.source === "installer",
            source: mine.source,
            effectiveFrom: mine.effectiveFrom,
            difference: mine.source === "installer" && standard.amount != null && mine.amount != null
              ? Number((mine.amount - standard.amount).toFixed(2))
              : null,
          };
        });

      /** Rates already written with a start date in the future. */
      const upcoming = Array.from(
        new Set(
          rates
            .filter((r) => r.effectiveFrom > on && (r.installerId === input.installerId || r.installerId === null))
            .map((r) => r.effectiveFrom),
        ),
      ).sort();

      return {
        installer: { id: installer.id, name: installer.name, active: installer.active },
        on,
        rows,
        customCount: rows.filter((r) => r.custom).length,
        pricedCount: rows.filter((r) => r.rate != null).length,
        upcoming,
        acknowledged: acks.map((a) => ({ effectiveFrom: a.effectiveFrom, at: a.acknowledgedAt })),
      };
    }),

  /**
   * The rate book as a QUOTING list: every work item with Terra's standard
   * rate, what it sells for, and who can lay it.
   *
   * Two ways in, on purpose, because the office thinks both ways:
   *   `groupName`  the category toggle. Carpet job, carpet rates, no typing.
   *   `search`     the escape hatch. "furniture" finds Furniture shift in the
   *                other category without anybody having to know it lives there.
   * Both together narrow; neither returns the lot.
   *
   * WHO IS OFFERED. Damien's rule: quote the standard rate, and an installer
   * who charges more than standard is not on the list. He is still counted and
   * named in `dearer` so nobody wonders where he went, but he cannot be picked
   * by accident. Anyone on Terra's default, or under it, is offered.
   *
   * Surcharges and allowances carry no skill, so they are never filtered out
   * by a category toggle the way trade work is.
   */
  picker: adminOnly
    .input(
      z
        .object({
          groupName: z.string().default(""),
          search: z.string().default(""),
          on: z.string().optional(),
          /** Items nobody has priced are hidden: a blank rate quotes as $0. */
          includeUnpriced: z.boolean().default(false),
        })
        .default({ groupName: "", search: "", includeUnpriced: false }),
    )
    .handler(async ({ input }) => {
      const on = input.on ?? today();
      const [items, rates, skillRows, installerRows, tickRows] = await Promise.all([
        db
          .select()
          .from(schema.labourRateItems)
          .where(eq(schema.labourRateItems.active, true))
          .orderBy(asc(schema.labourRateItems.sortOrder), asc(schema.labourRateItems.name)),
        loadRates(),
        db.select({ id: schema.skills.id, name: schema.skills.name }).from(schema.skills),
        db
          .select({ id: schema.installers.id, name: schema.installers.name })
          .from(schema.installers)
          .where(eq(schema.installers.active, true))
          .orderBy(asc(schema.installers.name)),
        db.select().from(schema.installerSkills),
      ]);

      const skillName = new Map(skillRows.map((s) => [s.id, s.name]));
      const installerName = new Map(installerRows.map((i) => [i.id, i.name]));
      /** skillId -> installers ticked for it. The dispatch tick list, reused. */
      const canDo = new Map<number, number[]>();
      for (const t of tickRows) {
        if (!installerName.has(t.installerId)) continue;
        const list = canDo.get(t.skillId) ?? [];
        list.push(t.installerId);
        canDo.set(t.skillId, list);
      }

      const needle = input.search.trim().toLowerCase();
      const wanted = input.groupName.trim().toLowerCase();

      const rows = items
        .filter((i) => {
          if (!wanted) return true;
          // A loading or an allowance belongs to every trade, so it always shows.
          if (i.kind !== "work") return true;
          return i.groupName.toLowerCase() === wanted;
        })
        .filter((i) => {
          if (!needle) return true;
          const hay = `${i.name} ${i.groupName} ${i.unit} ${skillName.get(i.skillId ?? -1) ?? ""}`;
          return hay.toLowerCase().includes(needle);
        })
        .map((i) => {
          const std = pick(rates, i.id, null, on);
          const ticked = i.skillId ? (canDo.get(i.skillId) ?? []) : [];

          const layers: { installerId: number; name: string; rate: number | null; ownRate: boolean }[] = [];
          const dearer: { installerId: number; name: string; rate: number }[] = [];

          for (const id of ticked) {
            const mine = pick(rates, i.id, id, on);
            const name = installerName.get(id) ?? "";
            if (mine.amount != null && std.amount != null && mine.amount > std.amount) {
              dearer.push({ installerId: id, name, rate: mine.amount });
              continue;
            }
            layers.push({
              installerId: id,
              name,
              rate: mine.amount,
              ownRate: mine.source === "installer",
            });
          }
          layers.sort((a, b) => a.name.localeCompare(b.name));
          dearer.sort((a, b) => a.rate - b.rate);

          return {
            itemId: i.id,
            name: i.name,
            groupName: i.groupName,
            kind: i.kind,
            unit: i.unit,
            skillId: i.skillId,
            skillName: i.skillId ? (skillName.get(i.skillId) ?? null) : null,
            notes: i.notes,
            /** What Terra pays. Never shown to an installer or a customer. */
            rate: std.amount,
            minimumCharge: std.minimumCharge,
            /**
             * What it quotes at. The standard chain, unless the item carries
             * its own markup, which is how a tip run goes out at cost plus 15%.
             */
            sell: std.amount == null ? null : sellExGstWithMarkup(std.amount, i.markupPercent),
            markupPercent: i.markupPercent,
            layers,
            dearer,
          };
        })
        .filter((r) => (input.includeUnpriced ? true : r.rate != null));

      /** Only categories that actually have work in them, for the toggles. */
      const groups = GROUPS.map((g) => ({
        name: g,
        count: items.filter((i) => i.active && i.kind === "work" && i.groupName === g).length,
      })).filter((g) => g.count > 0);

      return { on, rows, groups, unpricedHidden: input.includeUnpriced ? 0 : items.length - rows.length };
    }),

  /* ------------------------------------------------------------------ *
   * Terra Crew — his own rates, and nothing else
   * ------------------------------------------------------------------ */

  /**
   * What the installer sees in the app. Deliberately thin: the item, his rate,
   * the unit. No Terra default, no other installer, no sell price, no margin.
   */
  myRates: installerOnly.handler(async ({ context }) => {
    const on = today();
    const [items, rates, ticks, acks] = await Promise.all([
      db
        .select()
        .from(schema.labourRateItems)
        .where(eq(schema.labourRateItems.active, true))
        .orderBy(asc(schema.labourRateItems.sortOrder)),
      loadRates(),
      db
        .select({ skillId: schema.installerSkills.skillId })
        .from(schema.installerSkills)
        .where(eq(schema.installerSkills.installerId, context.installerId)),
      db
        .select()
        .from(schema.rateAcknowledgements)
        .where(eq(schema.rateAcknowledgements.installerId, context.installerId)),
    ]);

    const ticked = new Set(ticks.map((t) => t.skillId));
    const mine = items
      .filter((i) => i.skillId == null || ticked.has(i.skillId))
      .map((i) => ({ item: i, now: pick(rates, i.id, context.installerId, on) }))
      .filter((r) => r.now.amount != null);

    // A future dated card he has not ticked off yet.
    const futureDates = Array.from(
      new Set(
        rates
          .filter((r) => r.effectiveFrom > on && (r.installerId === context.installerId || r.installerId === null))
          .map((r) => r.effectiveFrom),
      ),
    ).sort();
    const ackDates = new Set(acks.map((a) => a.effectiveFrom));
    const pendingFrom = futureDates.find((d) => !ackDates.has(d)) ?? null;

    const changes = pendingFrom
      ? items
          .filter((i) => i.skillId == null || ticked.has(i.skillId))
          .map((i) => ({ item: i, before: pick(rates, i.id, context.installerId, on), after: pick(rates, i.id, context.installerId, pendingFrom) }))
          .filter((r) => r.before.amount !== r.after.amount)
          .map((r) => ({
            name: r.item.name,
            unit: r.item.unit,
            was: r.before.amount,
            now: r.after.amount,
          }))
      : [];

    return {
      on,
      rates: mine.map((r) => ({
        itemId: r.item.id,
        name: r.item.name,
        groupName: r.item.groupName,
        kind: r.item.kind,
        unit: r.item.unit,
        amount: r.now.amount,
        minimumCharge: r.now.minimumCharge,
        effectiveFrom: r.now.effectiveFrom,
      })),
      pendingChange: pendingFrom ? { effectiveFrom: pendingFrom, changes } : null,
      acknowledged: acks.map((a) => ({ effectiveFrom: a.effectiveFrom, at: a.acknowledgedAt })),
    };
  }),

  /** He ticks to say he's seen the new card. Time stamped, kept. */
  acknowledge: installerOnly
    .input(z.object({ effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .handler(async ({ input, context }) => {
      await db
        .insert(schema.rateAcknowledgements)
        .values({ installerId: context.installerId, effectiveFrom: input.effectiveFrom, acknowledgedAt: new Date() })
        .onConflictDoNothing();
      return { ok: true };
    }),

  /** Units and groups, for pickers. Any signed-in office user. */
  meta: authed.handler(async () => ({ units: UNITS, groups: GROUPS, kinds: KINDS })),
};

/** Shared with the job costing route so both price work the same way. */
export const rateBook = { pick, loadRates, today, dayBefore };
