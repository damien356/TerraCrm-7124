import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { withUser, type Actor } from "../middleware/auth";
import { rebuildForecast } from "../lib/cashflow";
import { auDate } from "../lib/invoice-match";
import { todayISO } from "../lib/pricing";
import { EMAIL_RE } from "../lib/quote-email";
import { checkSignature, signatureInput, tidySignature } from "../lib/signature";
import { SUPPLY_TERMS_VERSION } from "../lib/supplyTerms";
import { acceptVariation, rejectVariation } from "../lib/variation-accept";
import { addressedFor, billNoteOf, sendVariationSignedCopy, variationPdfFor, variationPhotos } from "../lib/variation-send";
import { VARIATION_ACCEPT_HEADING, variationAcceptText } from "../lib/variationPdf";
import { itemsOf, type Variation } from "../lib/variations";

/* ---------------------------------------------------------------------------
 * /v/<token>: the client reads a variation, signs and accepts it, or
 * declines it (item 12). No login. The token is the only key.
 *
 * The client sees what the work is, the qty and the totals. Never a unit
 * price, a cost or a markup, the same as the PDF. Sign only: no card, no
 * bank details, nothing to pay. It goes on the final or end invoice.
 * ------------------------------------------------------------------------- */

const notFound = () => new ORPCError("NOT_FOUND", { message: "This link is not valid. Check the message we sent, or reply to it and we will help." });
const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const isStaff = (actor: Actor | null | undefined) => !!actor && (actor.role === "admin" || actor.role === "office");
const token = z.string().min(20).max(80);

function clientIp(headers: Headers) {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (headers.get("cf-connecting-ip") || fwd || headers.get("x-real-ip") || "").slice(0, 64) || null;
}

async function byToken(t: string) {
  const [v] = await db.select().from(schema.variations).where(eq(schema.variations.token, t));
  if (!v) throw notFound();
  return v;
}

type PageState = "open" | "accepted" | "declined" | "being_updated" | "not_ready";

function stateOf(v: Variation): PageState {
  if (v.status === "sent") return "open";
  if (v.status === "approved" || v.status === "invoiced") return "accepted";
  if (v.status === "rejected") return "declined";
  // A draft that went out once is being changed by the office.
  return v.sentAt ? "being_updated" : "not_ready";
}

async function latestSignature(variationId: number) {
  const [s] = await db
    .select()
    .from(schema.variationSignatures)
    .where(eq(schema.variationSignatures.variationId, variationId))
    .orderBy(desc(schema.variationSignatures.id))
    .limit(1);
  return s ?? null;
}

async function countView(v: Variation) {
  const now = new Date();
  await db
    .update(schema.variations)
    .set({ views: sql`${schema.variations.views} + 1`, firstViewedAt: v.firstViewedAt ?? now, lastViewedAt: now })
    .where(eq(schema.variations.id, v.id));
}

export const publicVariation = {
  get: withUser.input(z.object({ token })).handler(async ({ input, context }) => {
    let v = await byToken(input.token);
    const staff = isStaff(context.actor);
    const state = stateOf(v);
    if ((state === "not_ready" || state === "being_updated") && !staff) {
      return { full: false as const, state, preview: false as const, ref: v.ref };
    }
    if (!staff) {
      await countView(v);
      v = await byToken(input.token);
    }
    const to = await addressedFor(v);
    const lines = await itemsOf(v.id);
    const sig = await latestSignature(v.id);
    return {
      full: true as const,
      state,
      preview: staff && state !== "open" && state !== "accepted" && state !== "declined",
      ref: v.ref,
      views: staff ? v.views : null,
      date: auDate(todayISO(v.sentAt ?? v.createdAt)),
      jobRef: to.jobRef,
      quoteRef: to.quoteRef,
      to: { name: to.name, company: to.company, siteAddress: to.siteAddress, email: to.email },
      reason: v.description,
      photos: (await variationPhotos(v)).map((p) => ({ id: p.id, caption: p.caption, kind: p.kind, url: p.url })),
      lines: lines.map((l) => ({ description: l.description, qty: l.qty, unit: l.unit })),
      subtotal: v.subtotal,
      gst: v.gst,
      total: v.total,
      billNote: billNoteOf(to.billedToCompany),
      billedToCompany: to.billedToCompany,
      acceptHeading: VARIATION_ACCEPT_HEADING,
      acceptText: variationAcceptText(to.jobRef),
      signature: sig ? { name: sig.name, position: sig.position, signedAt: sig.signedAt } : null,
      declinedAt: v.rejectedAt,
    };
  }),

  /** The variation as a PDF, signed once it is signed. */
  pdf: withUser.input(z.object({ token })).handler(async ({ input, context }) => {
    const v = await byToken(input.token);
    const state = stateOf(v);
    if ((state === "not_ready" || state === "being_updated") && !isStaff(context.actor)) throw notFound();
    const sig = await latestSignature(v.id);
    const signed = sig
      ? { name: sig.name, position: sig.position, date: auDate(todayISO(sig.signedAt)), signature: JSON.parse(sig.signatureJson) }
      : undefined;
    const { pdf, filename } = await variationPdfFor(v.id, signed);
    return { filename, base64: pdf.toString("base64") };
  }),

  accept: withUser
    .input(
      z.object({
        token,
        name: z.string().trim().min(2, "Type your full name.").max(120),
        position: z.string().trim().max(120).default(""),
        email: z.string().trim().max(200).nullish(),
        agreed: z.literal(true, { message: "Tick the box to accept the variation." }),
        signature: signatureInput,
      }),
    )
    .handler(async ({ input, context }) => {
      const v = await byToken(input.token);
      const state = stateOf(v);
      if (state === "accepted") throw bad("This variation is already accepted. Thank you.");
      if (state === "declined") throw bad("This variation was declined. Reply to our message and we will send a new one.");
      if (state === "being_updated") throw bad("We are updating this variation. We will send you the new one shortly.");
      if (state === "not_ready") throw notFound();
      const email = input.email?.trim() || null;
      if (email && !EMAIL_RE.test(email)) throw bad(`"${email}" is not an email address.`);
      const problem = checkSignature(input.signature);
      if (problem) throw bad(problem);
      const signature = tidySignature(input.signature);

      // The accept locks it first, so two people signing at once cannot both win.
      const out = await acceptVariation({ id: v.id, actor: { name: input.name, role: "customer" }, via: "online" });
      const signedAt = new Date();
      const [sig] = await db
        .insert(schema.variationSignatures)
        .values({
          variationId: v.id,
          name: input.name,
          position: input.position,
          email,
          signatureJson: JSON.stringify(signature),
          termsVersion: SUPPLY_TERMS_VERSION,
          signedAt,
          ip: clientIp(context.headers),
          userAgent: context.headers.get("user-agent")?.slice(0, 300) ?? null,
        })
        .returning();
      await db.insert(schema.activityLog).values({
        jobId: v.jobId,
        entityType: "variation",
        entityId: v.id,
        action: "signed_online",
        detail: `${input.name}${input.position ? `, ${input.position}` : ""} signed variation ${v.ref} online`,
        actorName: input.name,
        actorRole: "customer",
      });
      // The accept stands even if the signed copy fails. It is logged for the office to resend.
      if (sig) {
        try {
          await sendVariationSignedCopy({
            variation: out.variation,
            signatureId: sig.id,
            signerName: input.name,
            signerEmail: email,
            signed: { name: input.name, position: input.position, date: auDate(todayISO(signedAt)), signature },
          });
        } catch (e) {
          console.error("[variation] signed copy failed:", e);
        }
      }
      await rebuildForecast().catch((e) => console.error("[cashflow] rebuild after variation accept failed:", e));
      return {
        ref: v.ref,
        total: v.total,
        billNote: billNoteOf(out.billedToCompany),
        emailedTo: email,
      };
    }),

  decline: withUser
    .input(z.object({ token, name: z.string().trim().min(2, "Type your name.").max(120), reason: z.string().trim().max(1000).optional() }))
    .handler(async ({ input }) => {
      const v = await byToken(input.token);
      if (stateOf(v) !== "open") throw bad("This variation is not open any more.");
      await rejectVariation({ id: v.id, actor: { name: input.name, role: "customer" }, via: "online", reason: input.reason });
      return { ref: v.ref, declined: true as const };
    }),
};
