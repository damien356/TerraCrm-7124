import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminUserIds, sendPush } from "./push";
import { quoteRefOf } from "./quote-number";
import { OPS_URL } from "./swms-checks";

/* ---------------------------------------------------------------------------
 * The no-login links a client opens: /q/<token> to read and accept a quote
 * version, /m/<token> for the material selection form. Tokens are 32 random
 * characters, so a link cannot be guessed from a quote number.
 * ------------------------------------------------------------------------- */

/** Push Damien once a version has been opened this many times. */
export const VIEW_PUSH_AT = 3;

export const newToken = () => randomBytes(24).toString("base64url");

export const quoteUrl = (token: string) => `${OPS_URL}/q/${token}`;
export const selectionUrl = (token: string) => `${OPS_URL}/m/${token}`;

/** The link for one quote version. Made the first time it is asked for, the same link after that. */
export async function linkForQuote(quoteId: number) {
  const [found] = await db.select().from(schema.quoteLinks).where(eq(schema.quoteLinks.quoteId, quoteId));
  if (found) return found;
  await db.insert(schema.quoteLinks).values({ quoteId, token: newToken() }).onConflictDoNothing();
  const [row] = await db.select().from(schema.quoteLinks).where(eq(schema.quoteLinks.quoteId, quoteId));
  if (!row) throw new Error("Quote link not created");
  return row;
}

export async function linkByToken(token: string) {
  if (!token || token.length < 20 || token.length > 64) return null;
  const [row] = await db.select().from(schema.quoteLinks).where(eq(schema.quoteLinks.token, token));
  return row ?? null;
}

/**
 * Count one open of the link. Only by someone not signed in to Terra Ops, so
 * the office checking the page does not count. On the third open Damien gets
 * one push for this version, never a second.
 */
export async function recordQuoteView(link: typeof schema.quoteLinks.$inferSelect) {
  const now = new Date();
  const [row] = await db
    .update(schema.quoteLinks)
    .set({
      views: sql`${schema.quoteLinks.views} + 1`,
      firstViewedAt: link.firstViewedAt ?? now,
      lastViewedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.quoteLinks.id, link.id))
    .returning();
  if (!row || row.views < VIEW_PUSH_AT || row.viewPushSentAt) return row ?? link;

  // Claim the push first, so two opens at the same moment push once.
  const claimed = await db
    .update(schema.quoteLinks)
    .set({ viewPushSentAt: now })
    .where(and(eq(schema.quoteLinks.id, row.id), isNull(schema.quoteLinks.viewPushSentAt)))
    .returning({ id: schema.quoteLinks.id });
  if (!claimed.length) return row;

  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, row.quoteId));
  if (!quote) return row;
  const ref = await quoteRefOf(quote);
  const who = await clientNameFor(quote);
  await sendPush(await adminUserIds(), {
    title: `Quote ${ref} opened ${row.views} times`,
    body: `${who || "The client"} keeps looking at quote ${ref}. Good time to call.`,
    data: quote.jobId ? { kind: "job", jobId: quote.jobId } : { kind: "quote", quoteId: quote.id },
  });
  await db.insert(schema.activityLog).values({
    jobId: quote.jobId,
    contactId: quote.contactId,
    entityType: "quote",
    entityId: quote.id,
    action: "quote_viewed",
    detail: `Quote ${ref} opened ${row.views} times by the client. Damien was sent a push.`,
    actorName: "System",
    actorRole: "system",
  });
  return row;
}

/** The person the quote is addressed to, for pushes and greetings. */
export async function clientNameFor(quote: { contactId: number | null; supervisorContactId: number | null; companyId: number | null }) {
  const id = quote.supervisorContactId ?? quote.contactId;
  if (id) {
    const [c] = await db
      .select({ firstName: schema.contacts.firstName, lastName: schema.contacts.lastName })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, id));
    const name = [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim();
    if (name) return name;
  }
  if (quote.companyId) {
    const [co] = await db.select({ name: schema.companies.name }).from(schema.companies).where(eq(schema.companies.id, quote.companyId));
    if (co?.name) return co.name;
  }
  return "";
}

/** What the quote builder shows about the link: the url and how often it was opened. */
export async function linkSummary(quoteId: number) {
  const [link] = await db.select().from(schema.quoteLinks).where(eq(schema.quoteLinks.quoteId, quoteId));
  const [signature] = await db
    .select({
      id: schema.quoteSignatures.id,
      name: schema.quoteSignatures.name,
      position: schema.quoteSignatures.position,
      email: schema.quoteSignatures.email,
      signedAt: schema.quoteSignatures.signedAt,
      termsVersion: schema.quoteSignatures.termsVersion,
      hasPdf: sql<number>`${schema.quoteSignatures.pdfKey} is not null`,
    })
    .from(schema.quoteSignatures)
    .where(eq(schema.quoteSignatures.quoteId, quoteId))
    .orderBy(sql`${schema.quoteSignatures.id} desc`)
    .limit(1);
  return {
    url: link ? quoteUrl(link.token) : null,
    views: link?.views ?? 0,
    firstViewedAt: link?.firstViewedAt ?? null,
    lastViewedAt: link?.lastViewedAt ?? null,
    viewPushSentAt: link?.viewPushSentAt ?? null,
    signature: signature ? { ...signature, hasPdf: Boolean(signature.hasPdf) } : null,
  };
}
