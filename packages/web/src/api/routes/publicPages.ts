import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { withUser, type Actor } from "../middleware/auth";
import { bundlesFor, clientPdfFor } from "./quoteBundles";
import { rebuildForecast } from "../lib/cashflow";
import { depositInvoiceFor } from "../lib/client-invoices";
import { depositSplit } from "../lib/deposits";
import { auDate } from "../lib/invoice-match";
import { selectionForJob, submitSelection } from "../lib/material-selection";
import { todayISO } from "../lib/pricing";
import { acceptQuote } from "../lib/quote-accept";
import { EMAIL_RE, sendSignedCopy } from "../lib/quote-email";
import { linkByToken, linkForQuote, quoteUrl, recordQuoteView } from "../lib/quote-links";
import { quoteRefOf } from "../lib/quote-number";
import { TERRA_PRINT } from "../lib/quotePdf";
import { jobText } from "../lib/refs";
import { checkSignature, signatureInput, tidySignature } from "../lib/signature";
import { SUPPLY_TERMS, SUPPLY_TERMS_TITLE, SUPPLY_TERMS_VERSION } from "../lib/supplyTerms";

/* ---------------------------------------------------------------------------
 * The two pages a client opens without a login (spec section 2):
 *   /q/<token>  read the quote, the Supply Terms, sign and accept
 *   /m/<token>  the material selection form after accepting
 *
 * The token is the only key. Nothing here ever returns a cost, a markup, a
 * line quantity or a line price: the client sees bundles and totals, the
 * same as the PDF.
 * ------------------------------------------------------------------------- */

const notFound = () => new ORPCError("NOT_FOUND", { message: "This link is not valid. Check the email we sent, or reply to it and we will help." });
const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

const fullName = (c: { firstName?: string | null; lastName?: string | null } | null | undefined) =>
  [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim();

/** Admin and Office checking a link do not count as the client opening it. Field crew never get a preview. */
const isStaff = (actor: Actor | null | undefined) => !!actor && (actor.role === "admin" || actor.role === "office");

const NOT_READY = ["draft", "needs_review"];

function clientIp(headers: Headers) {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (headers.get("cf-connecting-ip") || fwd || headers.get("x-real-ip") || "").slice(0, 64) || null;
}

async function quoteForToken(token: string) {
  const link = await linkByToken(token);
  if (!link) throw notFound();
  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, link.quoteId));
  if (!quote) throw notFound();
  return { link, quote };
}

type Quote = typeof schema.quotes.$inferSelect;

/** Who it is addressed to and where, the same as the PDF header. */
async function addressedTo(quote: Quote) {
  const [contact] = quote.contactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, quote.contactId)) : [];
  const [supervisor] = quote.supervisorContactId
    ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, quote.supervisorContactId))
    : [];
  const [company] = quote.companyId ? await db.select().from(schema.companies).where(eq(schema.companies.id, quote.companyId)) : [];
  const [site] = quote.siteId ? await db.select().from(schema.sites).where(eq(schema.sites.id, quote.siteId)) : [];
  const person = supervisor ?? contact;
  return {
    name: fullName(person) || company?.name || "",
    company: company?.name ?? null,
    email: person?.email || company?.email || null,
    siteAddress: site
      ? [site.address, [site.suburb, site.state, site.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ")
      : null,
  };
}

/** A newer version that has gone out, so an old link can point at it. */
async function newerVersionUrl(quote: Quote) {
  const [newer] = await db
    .select({ id: schema.quotes.id })
    .from(schema.quotes)
    .where(
      and(
        eq(schema.quotes.number, quote.number),
        gt(schema.quotes.version, quote.version),
        inArray(schema.quotes.status, ["sent", "accepted"]),
      ),
    )
    .orderBy(desc(schema.quotes.version))
    .limit(1);
  if (!newer) return null;
  return quoteUrl((await linkForQuote(newer.id)).token);
}

type PageState = "open" | "accepted" | "declined" | "replaced" | "past_valid" | "not_ready";

function stateOf(quote: Quote): PageState {
  if (NOT_READY.includes(quote.status)) return "not_ready";
  if (quote.status === "accepted") return "accepted";
  if (quote.status === "declined") return "declined";
  if (quote.status === "replaced" || quote.status === "expired") return "replaced";
  if (quote.validUntil && quote.validUntil.getTime() < Date.now() - 86_400_000) return "past_valid";
  return "open";
}

const bank = () => ({ name: TERRA_PRINT.bank.name, bsb: TERRA_PRINT.bank.bsb, account: TERRA_PRINT.bank.account });

async function latestSignature(quoteId: number) {
  const [s] = await db
    .select({ name: schema.quoteSignatures.name, position: schema.quoteSignatures.position, signedAt: schema.quoteSignatures.signedAt })
    .from(schema.quoteSignatures)
    .where(eq(schema.quoteSignatures.quoteId, quoteId))
    .orderBy(desc(schema.quoteSignatures.id))
    .limit(1);
  return s ?? null;
}

async function depositFor(quoteId: number) {
  const inv = await depositInvoiceFor(quoteId);
  return inv ? { ref: inv.number, total: inv.total, paid: inv.status === "paid", owing: Math.max(0, Math.round((inv.total - inv.amountPaid) * 100) / 100) } : null;
}

const quotePage = {
  get: withUser.input(z.object({ token: z.string().min(1).max(80) })).handler(async ({ input, context }) => {
    const found = await quoteForToken(input.token);
    const staff = isStaff(context.actor);
    let quote = found.quote;
    const state = stateOf(quote);
    if (state === "not_ready" && !staff) {
      return { state, preview: false as const, ref: null, views: null };
    }
    if (!staff) await recordQuoteView(found.link);
    // Re-read: the view may have been the last thing to touch it.
    [quote] = (await db.select().from(schema.quotes).where(eq(schema.quotes.id, quote.id))) as [Quote];

    const ref = await quoteRefOf(quote);
    const to = await addressedTo(quote);
    const { bundles } = await bundlesFor(quote);
    const { deposit, balance } = depositSplit(quote.total, quote.depositPercent);
    return {
      state,
      /** Admin or Office looking at a quote that has not gone out yet. */
      preview: staff && state === "not_ready",
      ref,
      views: staff ? (await db.select({ v: schema.quoteLinks.views }).from(schema.quoteLinks).where(eq(schema.quoteLinks.id, found.link.id)))[0]?.v ?? 0 : null,
      date: auDate(todayISO(quote.sentAt ?? quote.createdAt)),
      validUntil: quote.validUntil ? auDate(todayISO(quote.validUntil)) : null,
      to,
      bundles: bundles.map((b) => ({ key: b.key, title: b.title, wording: b.wording, total: b.total })),
      subtotal: quote.subtotal,
      gst: quote.gst,
      total: quote.total,
      depositPercent: quote.depositPercent,
      deposit,
      balance,
      terms: { version: SUPPLY_TERMS_VERSION, title: SUPPLY_TERMS_TITLE, items: SUPPLY_TERMS },
      bank: bank(),
      signature: await latestSignature(quote.id),
      depositInvoice: await depositFor(quote.id),
      newerUrl: state === "replaced" ? await newerVersionUrl(quote) : null,
    };
  }),

  /** The quote as a PDF, signed if it has been signed. */
  pdf: withUser.input(z.object({ token: z.string().min(1).max(80) })).handler(async ({ input, context }) => {
    const { quote } = await quoteForToken(input.token);
    if (NOT_READY.includes(quote.status) && !isStaff(context.actor)) throw notFound();
    const [sig] = await db
      .select()
      .from(schema.quoteSignatures)
      .where(eq(schema.quoteSignatures.quoteId, quote.id))
      .orderBy(desc(schema.quoteSignatures.id))
      .limit(1);
    const signed = sig
      ? { name: sig.name, position: sig.position, date: auDate(todayISO(sig.signedAt)), signature: JSON.parse(sig.signatureJson) }
      : undefined;
    const { pdf, filename } = await clientPdfFor(quote.id, signed);
    return { filename, base64: pdf.toString("base64") };
  }),

  accept: withUser
    .input(
      z.object({
        token: z.string().min(1).max(80),
        name: z.string().trim().min(2, "Type your full name.").max(120),
        position: z.string().trim().max(120).default(""),
        email: z.string().trim().max(200).nullish(),
        agreed: z.literal(true, { message: "Tick the box to agree to the terms." }),
        signature: signatureInput,
      }),
    )
    .handler(async ({ input, context }) => {
      const { quote } = await quoteForToken(input.token);
      const state = stateOf(quote);
      if (state === "accepted") throw bad("This quote is already accepted. Thank you.");
      if (state === "replaced") throw bad("This version has been replaced by a newer quote. Open the newest email from us.");
      if (state === "declined") throw bad("This quote was declined. Reply to our email and we will send a new one.");
      if (state === "past_valid") throw bad("This quote has passed its valid until date. Reply to our email and we will update it for you.");
      if (state === "not_ready") throw notFound();
      const email = input.email?.trim() || null;
      if (email && !EMAIL_RE.test(email)) throw bad(`"${email}" is not an email address.`);
      const problem = checkSignature(input.signature);
      if (problem) throw bad(problem);
      const signature = tidySignature(input.signature);

      // The accept itself locks the quote, so two people signing at once cannot both win.
      const out = await acceptQuote({ quoteId: quote.id, actor: { name: input.name, role: "customer" }, via: "online" });
      const signedAt = new Date();
      const [sig] = await db
        .insert(schema.quoteSignatures)
        .values({
          quoteId: quote.id,
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
        jobId: out.jobId,
        contactId: quote.contactId,
        entityType: "quote",
        entityId: quote.id,
        action: "signed_online",
        detail: `${input.name}${input.position ? `, ${input.position}` : ""} signed quote ${out.ref} online and agreed to the Supply Terms (${SUPPLY_TERMS_VERSION})`,
        actorName: input.name,
        actorRole: "customer",
      });

      const deposit = out.invoice?.kind === "deposit" ? { ref: out.invoice.number, total: out.invoice.total } : null;
      // The accept stands even if the signed copy fails. It is logged for the office to resend.
      if (sig) {
        try {
          const [fresh] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quote.id));
          const { pdf, filename } = await clientPdfFor(quote.id, {
            name: input.name,
            position: input.position,
            date: auDate(todayISO(signedAt)),
            signature,
          });
          await sendSignedCopy({
            quote: fresh ?? out.quote,
            signatureId: sig.id,
            pdf,
            filename,
            ref: out.ref,
            signerName: input.name,
            signerEmail: email,
            deposit,
          });
        } catch (e) {
          console.error("[quote] signed copy failed:", e);
        }
      }
      await rebuildForecast().catch((e) => console.error("[cashflow] rebuild after online accept failed:", e));
      return { ref: out.ref, deposit, bank: bank(), emailedTo: email };
    }),
};

const selectionPage = {
  get: withUser.input(z.object({ token: z.string().min(1).max(80) })).handler(async ({ input }) => {
    const sel = await selectionByToken(input.token);
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, sel.jobId));
    const full = await selectionForJob(sel.jobId);
    const items =
      full && full.id === sel.id
        ? full.items
        : await db.select().from(schema.materialSelectionItems).where(eq(schema.materialSelectionItems.selectionId, sel.id));
    const [contact] = sel.contactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, sel.contactId)) : [];
    const [site] = job?.siteId ? await db.select().from(schema.sites).where(eq(schema.sites.id, job.siteId)) : [];
    return {
      jobRef: job ? jobText(job) : "",
      firstName: contact?.firstName?.trim() || "",
      siteAddress: site ? [site.address, site.suburb].filter(Boolean).join(", ") : null,
      status: sel.status,
      submittedAt: sel.submittedAt,
      submittedName: sel.submittedName,
      /** A newer form replaced this one. */
      superseded: !!full && full.id !== sel.id,
      items: items.map((i) => ({ areaId: i.areaId, room: i.room, product: i.product, colour: i.colour, notes: i.notes })),
    };
  }),

  submit: withUser
    .input(
      z.object({
        token: z.string().min(1).max(80),
        name: z.string().trim().min(2, "Type your name.").max(120),
        items: z
          .array(
            z.object({
              areaId: z.number().nullish(),
              room: z.string().max(120),
              product: z.string().max(200),
              colour: z.string().max(120),
              notes: z.string().max(1000),
            }),
          )
          .min(1)
          .max(60),
      }),
    )
    .handler(async ({ input }) => {
      const sel = await selectionByToken(input.token);
      const latest = await selectionForJob(sel.jobId);
      if (latest && latest.id !== sel.id) throw bad("This form has been replaced by a newer one. Open the newest email from us.");
      const out = await submitSelection(sel, input.name, input.items);
      return { status: out?.status ?? "submitted", submittedAt: out?.submittedAt ?? new Date() };
    }),
};

async function selectionByToken(token: string) {
  if (!token || token.length < 20 || token.length > 64) throw notFound();
  const [sel] = await db.select().from(schema.materialSelections).where(eq(schema.materialSelections.token, token));
  if (!sel) throw notFound();
  return sel;
}

export const publicPages = { quote: quotePage, selection: selectionPage };
