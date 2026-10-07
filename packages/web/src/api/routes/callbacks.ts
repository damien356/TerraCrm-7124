import { z } from "zod";
import { eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import {
  CALLBACK_CAUSES,
  CALLBACK_CAUSE_LABELS,
  CALLBACK_COST_KINDS,
  CALLBACK_COST_LABELS,
  addCost,
  addCostInput,
  callbackChain,
  callbackReport,
  createCallback,
  createCallbackInput,
  listCosts,
  originalInstallerId,
  originalJobFile,
  removeCost,
  setCause,
  setCauseInput,
  setChargeable,
} from "../lib/callbacks";

/**
 * CALLBACKS. A return visit to fix or finish something, linked to the
 * original job and shown as 3981-C1. Cause and chargeable are Admin and
 * Office; rework cost and the report are Admin only. Field crew never reach
 * any of this: they see a callback as a normal job through `field`.
 */
export const callbacks = {
  /** The pickers on the Create callback form. */
  options: staffOnly.handler(() => ({
    causes: CALLBACK_CAUSES.map((key) => ({ key, label: CALLBACK_CAUSE_LABELS[key] })),
    costKinds: CALLBACK_COST_KINDS.map((key) => ({ key, label: CALLBACK_COST_LABELS[key] })),
  })),

  create: staffOnly.input(createCallbackInput).handler(({ input, context }) => createCallback(input, context.actor)),

  /** The original and every callback on it, plus who did the original work. */
  chain: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const chain = await callbackChain(input.jobId);
    if (!chain) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
    const originalId = chain.root ? await originalInstallerId(chain.root.id) : null;
    const [orig] = originalId
      ? await db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, originalId))
      : [];
    return { ...chain, originalInstaller: orig ?? null };
  }),

  /** Products, notes and photos from the original job, read only, on the callback page. */
  original: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const [job] = await db.select({ parentJobId: schema.jobs.parentJobId }).from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
    if (!job?.parentJobId) throw new ORPCError("BAD_REQUEST", { message: "This job isn't a callback." });
    return originalJobFile(job.parentJobId);
  }),

  setCause: staffOnly.input(setCauseInput).handler(({ input, context }) => setCause(input, context.actor)),

  setChargeable: staffOnly
    .input(z.object({ jobId: z.number(), chargeable: z.boolean() }))
    .handler(({ input, context }) => setChargeable(input.jobId, input.chargeable, context.actor)),

  /** Rework cost. Admin only, because it is cost. Tracked and reported, never charged to the installer. */
  costs: adminOnly.input(z.object({ jobId: z.number() })).handler(({ input }) => listCosts(input.jobId)),
  addCost: adminOnly.input(addCostInput).handler(({ input, context }) => addCost(input, context.actor)),
  removeCost: adminOnly.input(z.object({ id: z.number() })).handler(({ input, context }) => removeCost(input.id, context.actor)),

  /** Callbacks and rework cost per installer and per cause, over a date range. */
  report: adminOnly
    .input(
      z
        .object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        })
        .default({}),
    )
    .handler(({ input }) => callbackReport(input)),
};
