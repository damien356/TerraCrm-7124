import { z } from "zod";
import { staffOnly } from "../middleware/auth";
import { rebuildForecast } from "../lib/cashflow";
import { deliveryStatus, markDelivered, recordHandover } from "../lib/delivery";

/* ---------------------------------------------------------------------------
 * Mark delivered, for supply only jobs (188001 fix list item 13). The proof
 * is uploaded straight to storage first (upload.presign, bucket completion),
 * then this files it, completes the job and raises the final invoice.
 * ------------------------------------------------------------------------- */

const rebuild = () => rebuildForecast().catch((e) => console.error("[cashflow] rebuild after delivery failed:", e));

const proofInput = z.object({
  storageKey: z.string().min(1).max(500),
  filename: z.string().max(300).nullish(),
  mime: z.string().max(120).nullish(),
  sizeBytes: z.number().nullish(),
});

export const delivery = {
  status: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => deliveryStatus(input.jobId)),

  markDelivered: staffOnly
    .input(
      z.object({
        jobId: z.number(),
        deliveredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        proofs: z
          .array(
            z.object({
              storageKey: z.string().min(1).max(500),
              filename: z.string().max(300).nullish(),
              mime: z.string().max(120).nullish(),
              sizeBytes: z.number().nullish(),
            }),
          )
          .min(1)
          .max(20),
        note: z.string().trim().max(300).nullish(),
      }),
    )
    .handler(async ({ input, context }) => {
      const out = await markDelivered({
        jobId: input.jobId,
        deliveredOn: input.deliveredOn,
        proofs: input.proofs,
        note: input.note ?? null,
        actor: { name: context.actor.name, role: context.actor.role, userId: context.actor.userId },
      });
      await rebuild();
      return out;
    }),

  /**
   * Fix 1 (Damien, 30 Oct): delivered or collected, all or part. Delivered
   * needs a proof file, collected needs who took it (a photo is optional).
   * The job completes when nothing is outstanding. Never marks anything paid.
   */
  recordHandover: staffOnly
    .input(
      z.object({
        jobId: z.number(),
        kind: z.enum(["delivered", "collected"]),
        on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        lines: z.array(z.object({ quoteItemId: z.number(), qty: z.number().min(0) })).max(100).nullable(),
        collectedBy: z.string().trim().max(120).nullish(),
        proofs: z.array(proofInput).max(20).default([]),
        note: z.string().trim().max(300).nullish(),
        batchKey: z.string().min(8).max(80),
      }),
    )
    .handler(async ({ input, context }) => {
      const out = await recordHandover({
        ...input,
        actor: { name: context.actor.name, role: context.actor.role, userId: context.actor.userId },
      });
      if (!out.reused) await rebuild();
      return out;
    }),
};
