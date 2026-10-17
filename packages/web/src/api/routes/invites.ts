import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { adminOnly, withUser } from "../middleware/auth";
import {
  appLinks,
  checkLink,
  downloadUrl,
  InviteError,
  inviteLog,
  linkWords,
  MAX_PASSWORD,
  MIN_PASSWORD,
  adminSetPassword,
  hasPasswordFor,
  saveAppLinks,
  sendInvite,
  setupLogin,
} from "../lib/invites";
import { eq, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { PLAY_REVIEW_EMAIL } from "../database/demo";

/* ---------------------------------------------------------------------------
 * Staff invites (notes 18.55). Sending, the log and the app links are Admin
 * only. The set-up page and the download page are public: the link itself
 * is the only key, and it works once.
 * ------------------------------------------------------------------------- */

const bad = (e: unknown): never => {
  if (e instanceof InviteError) throw new ORPCError("BAD_REQUEST", { message: e.message });
  throw e;
};

const token = z.string().trim().min(1).max(200);

export const invites = {
  /** Text or email a fresh invite. Older links for this person stop working once it has gone. */
  send: adminOnly
    .input(z.object({ profileId: z.number().int(), channel: z.enum(["sms", "email"]) }))
    .handler(async ({ input, context }) => {
      const r = await sendInvite(input.profileId, input.channel, context.actor.name || context.actor.email || "Admin").catch(bad);
      if (!r.ok) {
        const how = input.channel === "sms" ? "text" : "email";
        throw new ORPCError("BAD_REQUEST", {
          message: `The ${how} did not go (${r.reason}). It is in the invite log. Any older link they hold still works.`,
        });
      }
      return r;
    }),

  /** The invite log for one person. */
  log: adminOnly.input(z.object({ profileId: z.number().int() })).handler(async ({ input }) => {
    const m = await inviteLog([input.profileId]);
    return m.get(input.profileId) ?? [];
  }),

  /**
   * An Admin sets a password on a staff login (notes 18.58). The invite link
   * is still the normal way. This is for when a link can't get through.
   */
  setPassword: adminOnly
    .input(z.object({ profileId: z.number().int(), password: z.string().max(MAX_PASSWORD + 1) }))
    .handler(async ({ input, context }) => {
      const [p] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, input.profileId));
      if (!p) throw new ORPCError("NOT_FOUND", { message: "Login not found" });
      const actorName = context.actor.name || context.actor.email || "Admin";
      await adminSetPassword(p.userId, input.password, { actorName, label: p.name || p.email || "a login", profileId: p.id }).catch(bad);
      return { ok: true as const };
    }),

  /**
   * The App Store and Google Play reviewer login (notes 18.58). It has no row
   * in People: everything it does runs on the made up demo Terra, as one crew
   * member with one demo job (database/demo.ts). So it gets its own card.
   */
  reviewer: adminOnly.handler(async () => {
    const [u] = await db
      .select({ id: schema.user.id, name: schema.user.name })
      .from(schema.user)
      .where(sql`lower(${schema.user.email}) = ${PLAY_REVIEW_EMAIL}`);
    if (!u) return { email: PLAY_REVIEW_EMAIL, exists: false, hasPassword: false, lastSeenAt: null };
    const withPassword = await hasPasswordFor([u.id]);
    const [seen] = await db
      .select({ at: sql<number | null>`max(${schema.session.createdAt})` })
      .from(schema.session)
      .where(eq(schema.session.userId, u.id));
    return {
      email: PLAY_REVIEW_EMAIL,
      exists: true,
      hasPassword: withPassword.has(u.id),
      lastSeenAt: seen?.at ? new Date(Number(seen.at)).toISOString() : null,
    };
  }),

  reviewerSetPassword: adminOnly
    .input(z.object({ password: z.string().max(MAX_PASSWORD + 1) }))
    .handler(async ({ input, context }) => {
      const [u] = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(sql`lower(${schema.user.email}) = ${PLAY_REVIEW_EMAIL}`);
      if (!u) throw new ORPCError("NOT_FOUND", { message: "The reviewer login is missing." });
      const actorName = context.actor.name || context.actor.email || "Admin";
      await adminSetPassword(u.id, input.password, { actorName, label: "the store reviewer login", profileId: null }).catch(bad);
      return { ok: true as const };
    }),

  /** The iPhone and Android download links, as set in Settings. */
  linksGet: adminOnly.handler(async () => ({ ...(await appLinks()), downloadUrl: downloadUrl() })),

  linksSave: adminOnly
    .input(z.object({ ios: z.string().max(500), android: z.string().max(500) }))
    .handler(async ({ input }) => {
      return saveAppLinks(input).catch(bad);
    }),

  /** Public: what the /app page needs. */
  appLinks: withUser.handler(() => appLinks()),

  /** Public: is this set-up link still good. Never says whose it is unless it is. */
  check: withUser.input(z.object({ token })).handler(async ({ input }) => {
    const c = await checkLink(input.token);
    if (c.state === "ok") return { ...c, minPassword: MIN_PASSWORD, maxPassword: MAX_PASSWORD, message: "" };
    return { state: c.state, message: linkWords(c.state) };
  }),

  /** Public: choose the password. Replaces any password they already had. */
  setup: withUser
    .input(z.object({ token, password: z.string().max(MAX_PASSWORD + 1) }))
    .handler(async ({ input }) => {
      const r = await setupLogin(input.token, input.password).catch(bad);
      return { ok: true as const, email: r.email, role: r.role };
    }),
};
