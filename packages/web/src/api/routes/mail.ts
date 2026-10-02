import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { connectUrl, disconnect, MAILBOXES, mailboxFor, oauthConfigured, redirectUri, SEND_FROM, SEND_SCOPE } from "../lib/gmail";
import { AUTO_SEND_KEY, runMailAgent } from "../lib/mail-agent";
import { PRICE_SMS_KEY } from "../lib/price-check";
import { normaliseMobile, smsConfigured } from "../lib/sms";

/**
 * The email agent's mailboxes. Three addresses, fixed in code. Read only for
 * billing@ and damien@; team@ can also send. No route ever returns a token.
 */
export const mail = {
  status: adminOnly.handler(async () => {
    const rows = await db.select().from(schema.mailAccounts);
    const [auto] = await db.select().from(schema.settings).where(eq(schema.settings.key, AUTO_SEND_KEY));
    const [smsTo] = await db.select().from(schema.settings).where(eq(schema.settings.key, PRICE_SMS_KEY));
    const [{ read } = { read: 0 }] = await db.select({ read: sql<number>`count(*)` }).from(schema.mailMessages);
    return {
      configured: oauthConfigured(),
      redirectUri: redirectUri(),
      autoSend: auto?.value === "on",
      priceSmsTo: smsTo?.value ?? "",
      smsReady: smsConfigured(),
      messagesRead: read,
      mailboxes: MAILBOXES.map((m) => {
        const r = rows.find((x) => x.address === m.address);
        const connected = Boolean(r?.refreshTokenSealed);
        return {
          address: m.address,
          purpose: m.purpose,
          wantsSend: m.canSend,
          connected,
          canSend: connected && m.address === SEND_FROM && Boolean(r?.canSend) && (r?.scopes ?? "").split(" ").includes(SEND_SCOPE),
          connectedAt: connected ? (r?.connectedAt ?? null) : null,
          lastCheckedAt: r?.lastCheckedAt ?? null,
          // Kept after Google drops the sign-in, so Settings can say why. Disconnect clears it.
          lastError: r?.lastError ?? null,
        };
      }),
    };
  }),

  /** The Google sign-in link for one mailbox. Sign in AS that mailbox, not as yourself. */
  connect: adminOnly.input(z.object({ address: z.string() })).handler(async ({ input, context }) => {
    if (!oauthConfigured()) throw new ORPCError("PRECONDITION_FAILED", { message: "Google sign-in is not set up yet. The Client ID and secret need adding first." });
    const m = mailboxFor(input.address);
    if (!m) throw new ORPCError("BAD_REQUEST", { message: "Not a mailbox the agent may use." });
    const [p] = await db.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.userId, context.actor.userId));
    return { url: connectUrl(m.address, p?.id ?? null) };
  }),

  disconnect: adminOnly.input(z.object({ address: z.string() })).handler(async ({ input }) => {
    const m = mailboxFor(input.address);
    if (!m) throw new ORPCError("BAD_REQUEST", { message: "Not a mailbox the agent may use." });
    await disconnect(m.address);
    return { ok: true };
  }),

  /** The mobile that gets a text when a new price flag is over $50. Blank turns the texts off. */
  setPriceSms: adminOnly.input(z.object({ mobile: z.string().max(30) })).handler(async ({ input }) => {
    const raw = input.mobile.trim();
    const value = raw ? normaliseMobile(raw) : "";
    if (value === null) throw new ORPCError("BAD_REQUEST", { message: "That isn't an Australian mobile. Use 04xx xxx xxx." });
    await db
      .insert(schema.settings)
      .values({ key: PRICE_SMS_KEY, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
    return { mobile: value };
  }),

  /** Read new mail now instead of waiting for the 15 minute round. */
  checkNow: adminOnly.handler(async () => {
    const r = await runMailAgent();
    if ("skipped" in r) return { busy: true, runs: [], sent: 0 };
    return { busy: false, ...r };
  }),
};
