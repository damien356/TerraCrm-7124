import { z } from "zod";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { rateBook } from "./labour";

/**
 * JOB COSTING.
 *
 * What a job is going to make, before anyone is sent to it. The sell price comes
 * off the quote, the materials cost off the quote's unit costs, and the labour
 * off the rate book priced against whoever is doing it.
 *
 * Three rules:
 *
 *  1. Quantities are measured once and kept on the task. The money is not
 *     stored, it is worked out per installer, because the same 80m² costs
 *     different amounts depending on whose card it is priced against.
 *
 *  2. A missing rate is reported, never treated as zero. A costing screen that
 *     silently reads $0 is worse than one that says it does not know.
 *
 *  3. Once a task is assigned the labour is frozen onto the task. A rate rise
 *     next March must not quietly rewrite what a job in January cost.
 *
 * Nothing in here is ever exposed to an installer. Sell price, margin and GP
 * are admin only, enforced by the middleware on every procedure below.
 */

const { pick, loadRates, today } = rateBook;

const round2 = (n: number) => Math.round(n * 100) / 100;

type Line = typeof schema.taskLabourLines.$inferSelect;
type Item = typeof schema.labourRateItems.$inferSelect;
type Rate = typeof schema.labourRates.$inferSelect;

export type PricedLine = {
  lineId: number | null;
  itemId: number;
  name: string;
  kind: string;
  unit: string;
  qty: number;
  rate: number | null;
  /** installer = his own number · terra = the default · none = nobody priced it */
  source: "installer" | "terra" | "none";
  minimumCharge: number | null;
  /** True when the minimum charge beat qty × rate. */
  minimumApplied: boolean;
  total: number | null;
};

/**
 * Price one task's measured work against one installer's card, or against
 * Terra's standard when nobody is picked yet.
 *
 * Work items price on quantity. Surcharges in percent load the work total,
 * everything else (travel per km, a flat allowance) prices on quantity too.
 */
function priceLines(args: {
  lines: Line[];
  items: Map<number, Item>;
  rates: Rate[];
  installerId: number | null;
  on: string;
}) {
  const { lines, items, rates, installerId, on } = args;

  const priced: PricedLine[] = [];
  const unpriced: string[] = [];

  const resolve = (line: Line): PricedLine | null => {
    const item = items.get(line.itemId);
    if (!item) return null;
    const r = pick(rates, line.itemId, installerId, on);
    return {
      lineId: line.id,
      itemId: line.itemId,
      name: item.name,
      kind: item.kind,
      unit: item.unit,
      qty: line.qty,
      rate: r.amount,
      source: r.source,
      minimumCharge: r.minimumCharge,
      minimumApplied: false,
      total: null,
    };
  };

  const work = lines.map(resolve).filter((l): l is PricedLine => l !== null && l.kind === "work");
  const extras = lines.map(resolve).filter((l): l is PricedLine => l !== null && l.kind !== "work");

  let labour = 0;
  for (const l of work) {
    if (l.rate == null) {
      unpriced.push(l.name);
      priced.push(l);
      continue;
    }
    const raw = l.qty * l.rate;
    const floor = l.minimumCharge ?? 0;
    l.minimumApplied = floor > raw;
    l.total = round2(Math.max(raw, floor));
    labour += l.total;
    priced.push(l);
  }

  let other = 0;
  for (const l of extras) {
    if (l.rate == null) {
      unpriced.push(l.name);
      priced.push(l);
      continue;
    }
    // A percent surcharge loads the labour, not the sell price.
    l.total = l.unit === "percent" ? round2((labour * l.rate) / 100) : round2(l.qty * l.rate);
    other += l.total;
    priced.push(l);
  }

  return {
    lines: priced,
    labour: round2(labour),
    other: round2(other),
    total: round2(labour + other),
    unpriced,
    /** True when at least one line has no rate anywhere, so the total is short. */
    incomplete: unpriced.length > 0,
  };
}

/**
 * How long the work takes: quantity ÷ (what one man gets through in a day ×
 * how many men). Null when the skill has no production rate set, because a
 * made up duration is what puts a crew on a job that was never going to finish.
 */
function estimateDays(args: {
  lines: PricedLine[];
  productionRate: number | null;
  productionUnit: string | null;
  crew: number;
}) {
  const { lines, productionRate, productionUnit, crew } = args;
  if (!productionRate || productionRate <= 0) return null;
  const qty = lines
    .filter((l) => l.kind === "work" && l.unit === (productionUnit ?? "m2"))
    .reduce((sum, l) => sum + l.qty, 0);
  if (qty <= 0) return null;
  return Math.round((qty / (productionRate * Math.max(1, crew))) * 10) / 10;
}

/**
 * Lock a task's labour at the rates of the day. Called on assignment, so the
 * number the job was costed at is the number it keeps, whatever the rate book
 * does later. Nothing measured means nothing to lock, and that is not an error.
 */
export async function lockTaskLabour(args: { taskId: number; installerId?: number | null; on?: string }) {
  const on = args.on ?? today();
  const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, args.taskId));
  if (!task) return null;
  const installerId = args.installerId ?? task.assignedInstallerId ?? null;

  const [lines, itemRows, rates] = await Promise.all([
    db.select().from(schema.taskLabourLines).where(eq(schema.taskLabourLines.taskId, args.taskId)),
    db.select().from(schema.labourRateItems),
    loadRates(),
  ]);
  if (lines.length === 0) return null;

  const priced = priceLines({
    lines,
    items: new Map(itemRows.map((i) => [i.id, i])),
    rates,
    installerId,
    on,
  });

  await db
    .update(schema.jobTasks)
    .set({
      labourCost: priced.total,
      labourBreakdown: JSON.stringify(priced.lines),
      labourPricedOn: on,
      updatedAt: new Date(),
    })
    .where(eq(schema.jobTasks.id, args.taskId));

  return { taskId: args.taskId, labourCost: priced.total, pricedOn: on, incomplete: priced.incomplete };
}

export const costing = {
  /* ------------------------------------------------------------------ *
   * Measuring the work up
   * ------------------------------------------------------------------ */

  /**
   * The measured lines on a task, priced against whoever is on it, plus the
   * rate book items worth offering for that skill.
   */
  taskLines: adminOnly
    .input(z.object({ taskId: z.number(), installerId: z.number().nullable().default(null), on: z.string().optional() }))
    .handler(async ({ input }) => {
      const on = input.on ?? today();
      const [task] = await db
        .select({ task: schema.jobTasks, skill: schema.skills })
        .from(schema.jobTasks)
        .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
        .where(eq(schema.jobTasks.id, input.taskId));
      if (!task) throw new Error("No such task");

      const installerId = input.installerId ?? task.task.assignedInstallerId ?? null;
      const [installer] = installerId
        ? await db.select().from(schema.installers).where(eq(schema.installers.id, installerId))
        : [];

      const [lines, itemRows, rates] = await Promise.all([
        db
          .select()
          .from(schema.taskLabourLines)
          .where(eq(schema.taskLabourLines.taskId, input.taskId))
          .orderBy(asc(schema.taskLabourLines.sortOrder), asc(schema.taskLabourLines.id)),
        db
          .select()
          .from(schema.labourRateItems)
          .where(eq(schema.labourRateItems.active, true))
          .orderBy(asc(schema.labourRateItems.sortOrder)),
        loadRates(),
      ]);

      const items = new Map(itemRows.map((i) => [i.id, i]));
      const result = priceLines({ lines, items, rates, installerId, on });

      // What to offer in the picker: this skill's items, plus every surcharge
      // and allowance, since those are not tied to a trade.
      const suggestions = itemRows
        .filter((i) => (task.skill ? i.skillId === task.skill.id : false) || i.kind !== "work")
        .map((i) => ({ id: i.id, name: i.name, unit: i.unit, kind: i.kind, groupName: i.groupName }));

      return {
        taskId: input.taskId,
        on,
        installerId,
        installer: installer ? { id: installer.id, name: installer.name } : null,
        skill: task.skill ? { id: task.skill.id, name: task.skill.name } : null,
        crewSize: task.task.crewSize,
        ...result,
        days: estimateDays({
          lines: result.lines,
          productionRate: task.skill?.productionRate ?? null,
          productionUnit: task.skill?.productionUnit ?? null,
          crew: task.task.crewSize,
        }),
        frozen: task.task.labourCost == null
          ? null
          : { cost: task.task.labourCost, pricedOn: task.task.labourPricedOn },
        suggestions,
      };
    }),

  /** Measure a line on, or change the quantity. Zero takes it off. */
  setLine: adminOnly
    .input(z.object({ taskId: z.number(), itemId: z.number(), qty: z.number().min(0), note: z.string().nullable().default(null) }))
    .handler(async ({ input }) => {
      const [existing] = await db
        .select()
        .from(schema.taskLabourLines)
        .where(and(eq(schema.taskLabourLines.taskId, input.taskId), eq(schema.taskLabourLines.itemId, input.itemId)));

      if (input.qty === 0) {
        if (existing) await db.delete(schema.taskLabourLines).where(eq(schema.taskLabourLines.id, existing.id));
        return { removed: true };
      }

      if (existing) {
        const [row] = await db
          .update(schema.taskLabourLines)
          .set({ qty: input.qty, note: input.note, updatedAt: new Date() })
          .where(eq(schema.taskLabourLines.id, existing.id))
          .returning();
        return row!;
      }

      const [row] = await db
        .insert(schema.taskLabourLines)
        .values({ taskId: input.taskId, itemId: input.itemId, qty: input.qty, note: input.note })
        .returning();
      return row!;
    }),

  removeLine: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.taskLabourLines).where(eq(schema.taskLabourLines.id, input.id));
    return { ok: true };
  }),

  /* ------------------------------------------------------------------ *
   * The job's numbers
   * ------------------------------------------------------------------ */

  /**
   * Sale, materials, labour, other, GP and margin for a whole job, with the
   * labour priced against whoever is on each task. Pass installerId to see
   * what the job looks like if that one man did all of it.
   */
  forecast: adminOnly
    .input(
      z.object({
        jobId: z.number(),
        /** Price every task against this installer instead of who is on it. */
        installerId: z.number().nullable().default(null),
        on: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const on = input.on ?? today();

      const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
      if (!job) throw new Error("No such job");

      const [tasks, quoteRows, itemRows, rates, installerRows] = await Promise.all([
        db
          .select({ task: schema.jobTasks, skill: schema.skills, installer: schema.installers })
          .from(schema.jobTasks)
          .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
          .leftJoin(schema.installers, eq(schema.installers.id, schema.jobTasks.assignedInstallerId))
          .where(eq(schema.jobTasks.jobId, input.jobId))
          .orderBy(asc(schema.jobTasks.seq)),
        db
          .select()
          .from(schema.quotes)
          .where(eq(schema.quotes.jobId, input.jobId))
          .orderBy(desc(schema.quotes.version)),
        db
          .select()
          .from(schema.labourRateItems)
          .orderBy(asc(schema.labourRateItems.sortOrder)),
        loadRates(),
        db.select().from(schema.installers).where(eq(schema.installers.active, true)),
      ]);

      // The quote that counts: the accepted one, else the newest version.
      const quote = quoteRows.find((q) => q.status === "accepted") ?? quoteRows[0] ?? null;
      const quoteItems = quote
        ? await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quote.id))
        : [];

      /** Sale ex GST. The quote's subtotal, or the job value if there's no quote. */
      const revenue = round2(quote ? quote.subtotal : job.value);
      const materials = round2(
        quoteItems
          .filter((i) => i.kind === "supply" || i.kind === "accessory")
          .reduce((sum, i) => sum + (i.unitCost ?? 0) * (i.qty ?? 0), 0),
      );
      const materialsUnknown = quoteItems.some(
        (i) => (i.kind === "supply" || i.kind === "accessory") && i.unitCost == null,
      );

      const items = new Map(itemRows.map((i) => [i.id, i]));
      const taskIds = tasks.map((t) => t.task.id);
      const allLines = taskIds.length
        ? await db.select().from(schema.taskLabourLines).where(inArray(schema.taskLabourLines.taskId, taskIds))
        : [];

      const taskViews = tasks.map((t) => {
        const lines = allLines.filter((l) => l.taskId === t.task.id);
        const pricedAgainst = input.installerId ?? t.task.assignedInstallerId ?? null;

        // Frozen tasks read back at what they were priced at, not today's rates.
        const frozen = t.task.labourCost != null && input.installerId == null;
        const live = priceLines({ lines, items, rates, installerId: pricedAgainst, on });

        // Split a frozen total back into work and extras off the stored
        // breakdown, so the screen still shows where the money went.
        let frozenLabour = round2(t.task.labourCost ?? 0);
        let frozenOther = 0;
        if (frozen && t.task.labourBreakdown) {
          try {
            const stored = JSON.parse(t.task.labourBreakdown) as PricedLine[];
            const work = stored.filter((l) => l.kind === "work").reduce((sum, l) => sum + (l.total ?? 0), 0);
            const extras = stored.filter((l) => l.kind !== "work").reduce((sum, l) => sum + (l.total ?? 0), 0);
            if (round2(work + extras) === frozenLabour) {
              frozenLabour = round2(work);
              frozenOther = round2(extras);
            }
          } catch {
            // Unreadable breakdown: the total still stands, just unsplit.
          }
        }

        return {
          taskId: t.task.id,
          seq: t.task.seq,
          title: t.task.title,
          status: t.task.status,
          skill: t.skill ? { id: t.skill.id, name: t.skill.name } : null,
          installer: t.installer ? { id: t.installer.id, name: t.installer.name } : null,
          pricedAgainst,
          crewSize: t.task.crewSize,
          measured: lines.length,
          labour: frozen ? frozenLabour : live.labour,
          other: frozen ? frozenOther : live.other,
          total: frozen ? round2(t.task.labourCost!) : live.total,
          frozen,
          pricedOn: frozen ? t.task.labourPricedOn : on,
          unpriced: live.unpriced,
          incomplete: lines.length === 0 || live.incomplete,
          lines: live.lines,
          days: estimateDays({
            lines: live.lines,
            productionRate: t.skill?.productionRate ?? null,
            productionUnit: t.skill?.productionUnit ?? null,
            crew: t.task.crewSize,
          }),
        };
      });

      const labour = round2(taskViews.reduce((sum, t) => sum + t.labour, 0));
      const other = round2(taskViews.reduce((sum, t) => sum + t.other, 0));
      const cost = round2(materials + labour + other);
      const gp = round2(revenue - cost);
      const margin = revenue > 0 ? round2((gp / revenue) * 100) : null;
      const days = taskViews.some((t) => t.days != null)
        ? round2(taskViews.reduce((sum, t) => sum + (t.days ?? 0), 0))
        : null;

      /**
       * What each installer would cost on this job. Only the men ticked for
       * every skill on it, since anyone else can't be given the whole job.
       */
      const neededSkills = Array.from(new Set(tasks.map((t) => t.task.skillId).filter((id): id is number => id != null)));
      const ticks = installerRows.length
        ? await db
            .select()
            .from(schema.installerSkills)
            .where(inArray(schema.installerSkills.installerId, installerRows.map((i) => i.id)))
        : [];

      const comparison = installerRows
        .map((inst) => {
          const his = new Set(ticks.filter((t) => t.installerId === inst.id).map((t) => t.skillId));
          const canDoAll = neededSkills.every((s) => his.has(s));
          let sum = 0;
          let incomplete = false;
          for (const t of tasks) {
            const lines = allLines.filter((l) => l.taskId === t.task.id);
            const p = priceLines({ lines, items, rates, installerId: inst.id, on });
            sum += p.total;
            if (p.incomplete || lines.length === 0) incomplete = true;
          }
          return {
            installerId: inst.id,
            name: inst.name,
            canDoAll,
            missingSkills: neededSkills.filter((s) => !his.has(s)).length,
            labour: round2(sum),
            gp: round2(revenue - materials - sum),
            margin: revenue > 0 ? round2(((revenue - materials - sum) / revenue) * 100) : null,
            incomplete,
          };
        })
        .sort((a, b) => Number(b.canDoAll) - Number(a.canDoAll) || a.labour - b.labour);

      return {
        jobId: job.id,
        number: job.number,
        on,
        quote: quote ? { id: quote.id, number: quote.number, version: quote.version, status: quote.status } : null,
        revenue,
        materials,
        materialsUnknown,
        labour,
        other,
        cost,
        gp,
        margin,
        days,
        /** True when something is missing, so the GP on screen is not the real one. */
        incomplete: taskViews.some((t) => t.incomplete) || materialsUnknown || revenue === 0,
        tasks: taskViews,
        comparison,
      };
    }),

  /**
   * Lock the labour onto the task at today's rates. Done when the work is
   * given to someone, so a later rate change cannot rewrite this job.
   */
  freeze: adminOnly
    .input(z.object({ taskId: z.number(), installerId: z.number().nullable().default(null), on: z.string().optional() }))
    .handler(async ({ input }) => {
      const locked = await lockTaskLabour(input);
      if (!locked) throw new Error("Nothing measured on this dispatch yet, so there is no labour to lock in.");
      return locked;
    }),

  /** Put a task back on live rates, e.g. the measure was wrong. */
  unfreeze: adminOnly.input(z.object({ taskId: z.number() })).handler(async ({ input }) => {
    await db
      .update(schema.jobTasks)
      .set({ labourCost: null, labourBreakdown: null, labourPricedOn: null, updatedAt: new Date() })
      .where(eq(schema.jobTasks.id, input.taskId));
    return { ok: true };
  }),
};
