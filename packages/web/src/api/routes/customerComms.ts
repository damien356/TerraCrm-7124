import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { adminOnly, staffOnly } from "../middleware/auth";
import { guideDrafts, retryGuide, sendGuides } from "../lib/comms-guides";
import { commsPanel, setBuilderRef, setDirectContactOk } from "../lib/comms-panel";
import {
  approveReview,
  pauseReview,
  resumeReview,
  retryReview,
  reviewDeclined,
  reviewReceived,
  reviewSettings,
  saveReviewSettings,
  setReviewRecipient,
  setReviewWhat,
  setupReview,
  stopReview,
} from "../lib/comms-review";

/* ---------------------------------------------------------------------------
 * Customer communications on a job (Damien, 31 Oct). The card reads from
 * `panel`. Quote follow-ups are changed through quoteFollowups.*, the care
 * series through care.*; review requests, hand sent guides, the builder ref
 * and "Builder has OK'd direct contact" are here.
 * ------------------------------------------------------------------------- */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const fail = (e: unknown): never => {
  if (e instanceof ORPCError) throw e;
  throw new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : String(e) });
};

async function panelOrThrow(jobId: number) {
  const p = await commsPanel(jobId);
  if (!p) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  return p;
}

const reviewId = z.object({ id: z.number().int() });

export const customerComms = {
  /** Everything on the card. Read only. */
  panel: staffOnly.input(z.object({ jobId: z.number().int() })).handler(({ input }) => panelOrThrow(input.jobId)),

  setBuilderRef: staffOnly.input(z.object({ jobId: z.number().int(), ref: z.string().max(80) })).handler(async ({ input, context }) => {
    await setBuilderRef(input.jobId, input.ref, context.actor.name).catch(fail);
    return { ok: true as const };
  }),

  setDirectContactOk: staffOnly.input(z.object({ jobId: z.number().int(), ok: z.boolean() })).handler(async ({ input, context }) => {
    await setDirectContactOk(input.jobId, input.ok, context.actor.name).catch(fail);
    return { ok: true as const };
  }),

  /* ---- review request ---- */

  reviewSettings: staffOnly.handler(async () => {
    const s = await reviewSettings();
    return { on: s.on, link: s.link, startedAt: s.startedAt?.getTime() ?? null };
  }),

  saveReviewSettings: adminOnly
    .input(z.object({ on: z.boolean().optional(), link: z.string().trim().max(500).optional() }))
    .handler(async ({ input }) => {
      if (input.link && !/^https:\/\/\S+$/.test(input.link)) fail(new Error("The review link must start with https://"));
      await saveReviewSettings(input).catch(fail);
      const s = await reviewSettings();
      return { on: s.on, link: s.link, startedAt: s.startedAt?.getTime() ?? null };
    }),

  reviewSetup: staffOnly.input(z.object({ jobId: z.number().int() })).handler(async ({ input, context }) => {
    await setupReview(input.jobId, context.actor.name).catch(fail);
    return { ok: true as const };
  }),

  reviewRecipient: staffOnly
    .input(z.object({ id: z.number().int(), contactId: z.number().int(), channel: z.enum(["email", "sms"]) }))
    .handler(async ({ input, context }) => {
      await setReviewRecipient(input.id, context.actor.name, input.contactId, input.channel).catch(fail);
      return { ok: true as const };
    }),

  reviewWhat: staffOnly.input(z.object({ id: z.number().int(), what: z.string().max(120) })).handler(async ({ input, context }) => {
    await setReviewWhat(input.id, context.actor.name, input.what).catch(fail);
    return { ok: true as const };
  }),

  /** Never sends at once. Returns the next planned send, or null while it waits for completion. */
  reviewApprove: staffOnly.input(reviewId).handler(async ({ input, context }) => {
    const r = await approveReview(input.id, context.actor.name).catch(fail);
    return { nextSendAt: r.nextSendAt?.getTime() ?? null };
  }),

  reviewPause: staffOnly
    .input(z.object({ id: z.number().int(), note: z.string().max(300).default(""), pauseProfileId: z.number().int().nullable(), pauseName: z.string().min(1).max(120), reviewDate: isoDate }))
    .handler(async ({ input, context }) => {
      await pauseReview(input.id, context.actor.name, input).catch(fail);
      return { ok: true as const };
    }),

  reviewResume: staffOnly.input(reviewId).handler(async ({ input, context }) => {
    await resumeReview(input.id, context.actor.name).catch(fail);
    return { ok: true as const };
  }),

  reviewRetry: staffOnly.input(reviewId).handler(async ({ input, context }) => {
    await retryReview(input.id, context.actor.name).catch(fail);
    return { ok: true as const };
  }),

  reviewStop: staffOnly.input(z.object({ id: z.number().int(), reason: z.string().max(300).default("") })).handler(async ({ input, context }) => {
    await stopReview(input.id, context.actor.name, input.reason).catch(fail);
    return { ok: true as const };
  }),

  /** "Review received — stop reminders". Google reviews are not detected. A second click keeps the first record. */
  reviewReceived: staffOnly.input(reviewId).handler(({ input, context }) => reviewReceived(input.id, context.actor.name).catch(fail)),

  /** They said no thanks. Stops for good on this job. */
  reviewDeclined: staffOnly
    .input(z.object({ id: z.number().int(), note: z.string().max(300).default("") }))
    .handler(({ input, context }) => reviewDeclined(input.id, context.actor.name, input.note).catch(fail)),

  /* ---- care guides sent by hand ---- */

  guideDrafts: staffOnly
    .input(z.object({ jobId: z.number().int(), contactId: z.number().int(), codes: z.array(z.string().max(10)).min(1).max(12) }))
    .handler(({ input }) => guideDrafts(input.jobId, input.contactId, input.codes).catch(fail)),

  guideSend: staffOnly
    .input(
      z.object({
        jobId: z.number().int(),
        contactId: z.number().int(),
        items: z.array(z.object({ code: z.string().max(10), subject: z.string().max(200), body: z.string().max(12_000) })).min(1).max(12),
        /** Codes already sent on this job that the office ticked "Send again" for. */
        sendAgain: z.array(z.string().max(10)).default([]),
        /** One per press of Send, from the browser. */
        requestKey: z.string().min(8).max(80),
      }),
    )
    .handler(({ input, context }) =>
      sendGuides({ ...input, byName: context.actor.name, profileId: context.actor.profileId }).catch(fail),
    ),

  guideRetry: staffOnly.input(z.object({ id: z.number().int() })).handler(({ input, context }) => retryGuide(input.id, context.actor.name, context.actor.profileId).catch(fail)),
};
