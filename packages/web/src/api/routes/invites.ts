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
  saveAppLinks,
  sendInvite,
  setupLogin,
} from "../lib/invites";

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
