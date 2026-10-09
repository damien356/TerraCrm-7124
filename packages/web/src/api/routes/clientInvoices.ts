import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { rebuildForecast } from "../lib/cashflow";
import { invoicesForJob, markInvoicePaid, PAYMENT_METHODS, shapeInvoice, voidInvoice } from "../lib/client-invoices";
import { createSelection, selectionForJob, sendSelection } from "../lib/material-selection";
import { EMAIL_RE } from "../lib/quote-email";

/* ---------------------------------------------------------------------------
 * The job page's money-in card and material selection card (spec section 2).
 * Admin and Office mark a client invoice paid. Only Admin voids one.
 * Until Stripe is connected every payment is marked here by hand.
 * ------------------------------------------------------------------------- */

const rebuild = () => rebuildForecast().catch((e) => console.error("[cashflow] rebuild after invoice change failed:", e));

const shapeSelection = (s: Awaited<ReturnType<typeof selectionForJob>>) =>
  s
    ? {
        id: s.id,
        status: s.status,
        url: s.url,
        sentTo: s.sentTo,
        sentAt: s.sentAt,
        submittedAt: s.submittedAt,
        submittedName: s.submittedName,
        items: s.items.map((i) => ({ id: i.id, areaId: i.areaId, room: i.room, product: i.product, colour: i.colour, notes: i.notes })),
      }
    : null;

export const clientInvoices = {
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const rows = await invoicesForJob(input.jobId);
    const live = rows.filter((r) => r.status !== "void");
    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
      invoices: rows,
      billed: round2(live.reduce((s, r) => s + r.total, 0)),
      received: round2(live.reduce((s, r) => s + r.amountPaid, 0)),
      owing: round2(live.reduce((s, r) => s + r.outstanding, 0)),
    };
  }),

  /** Money landed. Paid in full unless a part amount is given. */
  markPaid: staffOnly
    .input(
      z.object({
        id: z.number(),
        method: z.enum(PAYMENT_METHODS),
        amount: z.number().positive().nullish(),
        /** YYYY-MM-DD, the day the money arrived. Today if left out. */
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      }),
    )
    .handler(async ({ input, context }) => {
      const paidOn = input.paidOn ? new Date(`${input.paidOn}T12:00:00+10:00`) : null;
      if (paidOn && paidOn.getTime() > Date.now() + 86_400_000) {
        throw new ORPCError("BAD_REQUEST", { message: "The paid date cannot be in the future." });
      }
      const row = await markInvoicePaid({
        id: input.id,
        amount: input.amount ?? null,
        method: input.method,
        paidOn,
        byName: context.actor.name,
        actorRole: context.actor.role,
      });
      await rebuild();
      return shapeInvoice(row);
    }),

  void: adminOnly
    .input(z.object({ id: z.number(), reason: z.string().trim().min(3).max(300) }))
    .handler(async ({ input, context }) => {
      const row = await voidInvoice({ id: input.id, reason: input.reason, byName: context.actor.name, actorRole: context.actor.role });
      await rebuild();
      return row ? shapeInvoice(row) : null;
    }),

  selection: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    return shapeSelection(await selectionForJob(input.jobId));
  }),

  /** Send (or send again) the selection form. Makes one first if the job has none. */
  sendSelection: staffOnly
    .input(z.object({ jobId: z.number(), to: z.string().trim().max(200).nullish() }))
    .handler(async ({ input, context }) => {
      const [job] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
      if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
      if (input.to && !EMAIL_RE.test(input.to)) throw new ORPCError("BAD_REQUEST", { message: `"${input.to}" is not an email address.` });
      const sel = (await selectionForJob(job.id)) ?? (await createSelection({ jobId: job.id, quoteId: null }));
      if (input.to) {
        await db
          .update(schema.materialSelections)
          .set({ sentTo: input.to, updatedAt: new Date() })
          .where(eq(schema.materialSelections.id, sel.id));
      }
      const out = await sendSelection(sel.id, { name: context.actor.name });
      if (!out.sent) throw new ORPCError("BAD_REQUEST", { message: `Not sent: ${out.reason ?? "unknown reason"}` });
      return { ...out, selection: shapeSelection(await selectionForJob(job.id)) };
    }),
};
