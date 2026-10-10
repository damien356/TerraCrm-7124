import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, like, ne, or } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { markInvoicePaid } from "./client-invoices";
import { OPS_URL } from "./swms-checks";

/* ---------------------------------------------------------------------------
 * Pay by card (fix list item 6, 11 Oct). Stripe Checkout, no surcharge.
 *
 *   /pay/<token>   one link per client invoice (deposit, final, variation).
 *                  It never changes, so it can go in a PDF or an email. Each
 *                  click opens a fresh Stripe page for whatever is owing now.
 *
 * A payment lands two ways and both are safe to run twice:
 *   1. Stripe's webhook (/api/webhooks/stripe), signed with the webhook secret.
 *   2. The client coming back to /pay/<token>?session=..., where the server
 *      asks Stripe for that session itself. Never trusts the browser.
 * The payment id is claimed on the invoice first, so the same payment is
 * never counted twice.
 *
 * Talks to the Stripe REST API with fetch, no SDK. The key is read from the
 * environment and never logged.
 * ------------------------------------------------------------------------- */

const API = "https://api.stripe.com/v1";

const key = () => process.env.STRIPE_SECRET_KEY?.trim() || "";
export const cardPaymentsOn = () => key().startsWith("sk_");
export const stripeMode = () => (key().startsWith("sk_live_") ? "live" : key().startsWith("sk_test_") ? "test" : "off");

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Stripe wants nested form fields, e.g. line_items[0][price_data][currency]. */
function form(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") form(item as Record<string, unknown>, `${name}[${i}]`, out);
        else out.append(`${name}[${i}]`, String(item));
      });
    } else if (typeof v === "object") form(v as Record<string, unknown>, name, out);
    else out.append(name, String(v));
  }
  return out;
}

async function stripe<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
  if (!cardPaymentsOn()) throw new Error("Card payments are not set up.");
  const headers: Record<string, string> = { Authorization: `Bearer ${key()}`, "Stripe-Version": "2024-06-20" };
  const init: RequestInit = { method, headers };
  if (method === "POST" && body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = form(body).toString();
  }
  const res = await fetch(`${API}${path}`, init);
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe: ${json?.error?.message ?? res.status}`);
  return json;
}

/* --------------------------------- links --------------------------------- */

/**
 * The pay link token: the invoice id plus a signature only this server can
 * make, so a link cannot be guessed from an invoice number. No table needed.
 */
function sign(id: number) {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.MAIL_TOKEN_KEY || "terra-pay";
  return createHmac("sha256", secret).update(`terra-pay:${id}`).digest("base64url").slice(0, 22);
}
export const payToken = (invoiceId: number) => `${invoiceId}-${sign(invoiceId)}`;
export const payUrl = (invoiceId: number) => `${OPS_URL}/pay/${payToken(invoiceId)}`;

export function invoiceIdFromToken(token: string) {
  const m = /^(\d{1,10})-([A-Za-z0-9_-]{22})$/.exec(token ?? "");
  if (!m) return null;
  const id = Number(m[1]);
  const want = Buffer.from(sign(id));
  const got = Buffer.from(m[2]!);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

/* -------------------------------- checkout ------------------------------- */

type Invoice = typeof schema.invoices.$inferSelect;

export const owingOn = (inv: Invoice) => (inv.status === "void" || inv.status === "paid" ? 0 : Math.max(0, round2(inv.total - inv.amountPaid)));

/** The client's email, so Stripe sends the receipt there. */
async function emailFor(inv: Invoice) {
  if (inv.billToContactId) {
    const [c] = await db.select({ email: schema.contacts.email }).from(schema.contacts).where(eq(schema.contacts.id, inv.billToContactId));
    if (c?.email?.trim()) return c.email.trim();
  }
  if (inv.billToCompanyId) {
    const [co] = await db.select({ email: schema.companies.email }).from(schema.companies).where(eq(schema.companies.id, inv.billToCompanyId));
    if (co?.email?.trim()) return co.email.trim();
  }
  return null;
}

type Session = {
  id: string;
  url?: string | null;
  status?: string;
  payment_status?: string;
  amount_total?: number | null;
  currency?: string | null;
  payment_intent?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
};

/**
 * A Stripe Checkout page for what is owing on the invoice right now. Card
 * only (Apple Pay and Google Pay are cards too). The amount is the balance,
 * nothing added for the card.
 */
export async function checkoutForInvoice(invoiceId: number, back: { returnTo: string }) {
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv) throw new Error("Invoice not found.");
  const owing = owingOn(inv);
  if (!(owing > 0)) throw new Error(inv.status === "void" ? "This invoice has been cancelled." : "This invoice is already paid. Thank you.");
  const cents = Math.round(owing * 100);
  const email = await emailFor(inv);
  const sep = back.returnTo.includes("?") ? "&" : "?";
  const label = inv.label?.trim() || `Invoice ${inv.number}`;
  const session = await stripe<Session>("POST", "/checkout/sessions", {
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: email ?? undefined,
    client_reference_id: inv.number,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "aud",
          unit_amount: cents,
          product_data: { name: `Terra Flooring ${inv.number}`, description: label.slice(0, 300) },
        },
      },
    ],
    metadata: { terra_invoice_id: String(inv.id), terra_invoice: inv.number, terra_job: String(inv.jobNumber) },
    payment_intent_data: {
      description: `Terra Flooring ${inv.number}`,
      metadata: { terra_invoice_id: String(inv.id), terra_invoice: inv.number, terra_job: String(inv.jobNumber) },
    },
    success_url: `${back.returnTo}${sep}session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${back.returnTo}${sep}cancelled=1`,
  });
  if (!session.url) throw new Error("Stripe did not return a payment page.");
  return { url: session.url, sessionId: session.id, amount: owing };
}

/* ------------------------------ payment lands ----------------------------- */

const piOf = (s: Session) => (typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null));

export type Applied =
  | { ok: true; invoiceId: number; state: "paid" | "part_paid" | "already_counted"; amount: number }
  | { ok: false; reason: string; invoiceId?: number };

/**
 * Count a finished Checkout session against its invoice, once. A session
 * that is not ours (no terra_invoice_id, e.g. a Xero payment on the same
 * Stripe account) is ignored.
 */
export async function applySession(s: Session): Promise<Applied> {
  const invoiceId = Number(s.metadata?.terra_invoice_id ?? 0);
  if (!invoiceId) return { ok: false, reason: "not a Terra Ops payment" };
  if (s.payment_status !== "paid") return { ok: false, reason: `payment ${s.payment_status ?? "unknown"}`, invoiceId };
  if ((s.currency ?? "").toLowerCase() !== "aud") return { ok: false, reason: `currency ${s.currency}`, invoiceId };
  const pi = piOf(s) ?? s.id;
  const amount = round2((s.amount_total ?? 0) / 100);
  if (!(amount > 0)) return { ok: false, reason: "no amount", invoiceId };

  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv) return { ok: false, reason: "invoice not found", invoiceId };
  if (inv.stripePaymentIntentId === pi) return { ok: true, invoiceId, state: "already_counted", amount };
  // An older payment on a part paid invoice (the column only holds the latest one).
  const [seen] = await db
    .select({ id: schema.activityLog.id })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "invoice"), eq(schema.activityLog.entityId, inv.id), like(schema.activityLog.detail, `%${pi})%`)))
    .limit(1);
  if (seen) return { ok: true, invoiceId, state: "already_counted", amount };

  // Claim this payment on the invoice. Only one of the webhook and the return page wins.
  const [claimed] = await db
    .update(schema.invoices)
    .set({ stripePaymentIntentId: pi, updatedAt: new Date() })
    .where(and(eq(schema.invoices.id, inv.id), or(isNull(schema.invoices.stripePaymentIntentId), ne(schema.invoices.stripePaymentIntentId, pi))))
    .returning({ id: schema.invoices.id });
  if (!claimed) return { ok: true, invoiceId, state: "already_counted", amount };

  const who = s.customer_details?.name?.trim() || s.customer_details?.email?.trim() || "Client";
  const owing = owingOn(inv);
  if (owing <= 0.005 || amount > owing + 0.005) {
    // Paid twice (bank and card), or the balance dropped after the page opened. Money is in Stripe, so flag it, never lose it.
    await db.insert(schema.activityLog).values({
      jobId: inv.jobId,
      entityType: "invoice",
      entityId: inv.id,
      action: "card_payment_needs_attention",
      detail: `${inv.number}: card payment ${money(amount)} received in Stripe (${pi}) but only ${money(owing)} was owing. Refund or credit the difference in Stripe.`,
      actorName: who,
      actorRole: "customer",
    });
    if (owing > 0.005) {
      await markInvoicePaid({ id: inv.id, amount: owing, method: "card", byName: `${who} (Stripe)`, actorRole: "customer" });
    }
    return { ok: true, invoiceId, state: owing > 0.005 ? "paid" : "already_counted", amount };
  }
  let row: Invoice;
  try {
    row = await markInvoicePaid({ id: inv.id, amount, method: "card", byName: `${who} (Stripe)`, actorRole: "customer" });
  } catch (e) {
    await db.insert(schema.activityLog).values({
      jobId: inv.jobId,
      entityType: "invoice",
      entityId: inv.id,
      action: "card_payment_needs_attention",
      detail: `${inv.number}: card payment ${money(amount)} received in Stripe (${pi}) but could not be marked: ${String((e as Error)?.message ?? e).slice(0, 200)}. Mark it paid by hand.`,
      actorName: who,
      actorRole: "customer",
    });
    return { ok: false, reason: "could not mark paid, logged for the office", invoiceId };
  }
  await db.insert(schema.activityLog).values({
    jobId: inv.jobId,
    entityType: "invoice",
    entityId: inv.id,
    action: "card_payment",
    detail: `${inv.number}: ${money(amount)} paid by card online (Stripe ${pi})`,
    actorName: who,
    actorRole: "customer",
  });
  return { ok: true, invoiceId, state: row.status === "paid" ? "paid" : "part_paid", amount };
}

/** The client came back from Stripe. Ask Stripe, never the browser, whether it was paid. */
export async function confirmSession(sessionId: string, invoiceId: number) {
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId)) return { ok: false as const, reason: "bad session" };
  const s = await stripe<Session>("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (Number(s.metadata?.terra_invoice_id ?? 0) !== invoiceId) return { ok: false as const, reason: "session is for another invoice" };
  return applySession(s);
}

/* -------------------------------- webhook -------------------------------- */

/**
 * Stripe's signature check: HMAC-SHA256 of "<timestamp>.<raw body>" with the
 * webhook secret, any v1 entry may match, and not older than 5 minutes.
 */
export function verifyWebhook(raw: string, header: string | null | undefined, secret: string, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("=") as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1] ?? 0);
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex"));
  return parts
    .filter(([k]) => k === "v1")
    .some(([, v]) => {
      const got = Buffer.from(v ?? "");
      return got.length === want.length && timingSafeEqual(got, want);
    });
}

export async function handleWebhook(raw: string, signature: string | null | undefined) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || "";
  if (!secret) return { status: 503 as const, body: { ok: false, reason: "webhook secret not set" } };
  if (!verifyWebhook(raw, signature, secret)) return { status: 400 as const, body: { ok: false, reason: "bad signature" } };
  let event: { id?: string; type?: string; data?: { object?: Session } };
  try {
    event = JSON.parse(raw);
  } catch {
    return { status: 400 as const, body: { ok: false, reason: "unreadable" } };
  }
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return { status: 200 as const, body: { ok: true, ignored: event.type } };
  }
  const out = await applySession(event.data?.object ?? ({} as Session));
  return { status: 200 as const, body: { ok: true, result: out.ok ? out.state : out.reason } };
}

/** The deposit or invoice a page should offer to pay, by quote. */
export async function cardPayFor(inv: Invoice | null) {
  if (!inv || !cardPaymentsOn()) return null;
  const owing = owingOn(inv);
  return owing > 0 ? { url: payUrl(inv.id), owing } : null;
}

export const _test = { form, sign };
