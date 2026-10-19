import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import { emailConfigured } from "../lib/email";
import { hasPasswordFor, inviteLog, sendInvite } from "../lib/invites";
import { normaliseMobile, smsConfigured } from "../lib/sms";
import * as schema from "../database/schema";
import { adminOnly, ensureInstallerCard, normaliseRole } from "../middleware/auth";

/** There must always be at least one active Admin besides this person. */
async function assertAnotherAdmin(exceptProfileId: number) {
  const rows = await db.select().from(schema.profiles).where(eq(schema.profiles.active, true));
  const others = rows.filter((r) => r.id !== exceptProfileId && normaliseRole(r.role) === "admin");
  if (!others.length) throw new ORPCError("BAD_REQUEST", { message: "There must always be at least one active Admin." });
}

/**
 * The same rule inside the write itself, so two Admins removing each other at
 * the same moment cannot leave Terra with none.
 */
const anotherActiveAdmin = (profileId: number) =>
  sql`exists (select 1 from profiles other where other.id != ${profileId} and other.active = 1 and other.role = 'admin')`;

const cleanEmail = (raw: string) => raw.trim().toLowerCase();
const emailShape = z.string().trim().email("That email does not look right.");

/** Sign-in emails are unique. Better Auth lower-cases them, so compare that way. */
async function emailTaken(email: string, exceptUserId?: string) {
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(
      exceptUserId
        ? and(sql`lower(${schema.user.email}) = ${email}`, ne(schema.user.id, exceptUserId))
        : sql`lower(${schema.user.email}) = ${email}`,
    )
    .limit(1);
  return rows.length > 0;
}

/** Installer cards no login points at. Field crew can be added onto one. */
async function unlinkedCards() {
  const cards = await db
    .select({ id: schema.installers.id, name: schema.installers.name, mobile: schema.installers.mobile, email: schema.installers.email })
    .from(schema.installers)
    .where(isNull(schema.installers.archivedAt));
  const taken = await db.select({ installerId: schema.profiles.installerId }).from(schema.profiles);
  const used = new Set(taken.map((t) => t.installerId).filter((v): v is number => v != null));
  return cards.filter((c) => !used.has(c.id));
}

/**
 * Logins — every account that has ever signed in to Terra Ops.
 *
 * A Better Auth `user` row is just an email and a password/Google identity. It
 * gives the person NOTHING on its own: the office side needs role "admin", and
 * the installer app needs `profiles.installerId` pointing at an installer card.
 * That link is what this route exists for. The very first account to sign in is
 * promoted to admin automatically (see middleware/auth.ts); everyone after that
 * lands as an installer with no link and therefore sees nothing.
 */
export const team = {
  /** Every account: role, linked installer, when they signed up, last seen. */
  list: adminOnly.handler(async () => {
    const lastSeen = db
      .select({
        userId: schema.session.userId,
        // A login now runs for months, so the sign-in date says little. The
        // session is touched once a day while it is in use.
        seenAt: sql<number>`max(coalesce(${schema.session.updatedAt}, ${schema.session.createdAt}))`.as("seen_at"),
      })
      .from(schema.session)
      .groupBy(schema.session.userId)
      .as("last_seen");

    const rows = await db
      .select({
        profile: schema.profiles,
        authName: schema.user.name,
        authEmail: schema.user.email,
        signedUpAt: schema.user.createdAt,
        lastSeenAt: lastSeen.seenAt,
        installerName: schema.installers.name,
        installerActive: schema.installers.active,
        installerArchivedAt: schema.installers.archivedAt,
      })
      .from(schema.profiles)
      .leftJoin(schema.user, eq(schema.user.id, schema.profiles.userId))
      .leftJoin(lastSeen, eq(lastSeen.userId, schema.profiles.userId))
      .leftJoin(schema.installers, eq(schema.installers.id, schema.profiles.installerId))
      .orderBy(desc(schema.profiles.createdAt));

    const log = await inviteLog(rows.map((r) => r.profile.id));
    const withPassword = await hasPasswordFor(rows.map((r) => r.profile.userId));
    return rows.map((r) => ({
      id: r.profile.id,
      userId: r.profile.userId,
      name: r.profile.name || r.authName || "",
      email: r.profile.email || r.authEmail || "",
      role: normaliseRole(r.profile.role),
      phone: r.profile.phone ?? null,
      canSeeCosts: r.profile.canSeeCosts,
      installerArchived: r.installerArchivedAt ? true : false,
      active: r.profile.active,
      installerId: r.profile.installerId,
      installerName: r.installerName ?? null,
      installerActive: r.installerActive ?? null,
      signedUpAt: r.signedUpAt ? new Date(Number(r.signedUpAt)).toISOString() : null,
      lastSeenAt: r.lastSeenAt ? new Date(Number(r.lastSeenAt)).toISOString() : null,
      hasPassword: withPassword.has(r.profile.userId),
      invites: log.get(r.profile.id) ?? [],
    }));
  }),

  /**
   * Set a person's access level. This is the only place a level changes, and
   * only an Admin can reach it.
   *
   * Field crew: the installer card is created from the login (name, phone,
   * email), or restored with all its history and skills if it was archived.
   * Admin or Office: the card is archived. It leaves dispatch, but past jobs,
   * photos, notes, SWMS sign-offs and installer prices stay on those jobs.
   */
  setAccess: adminOnly
    .input(z.object({ profileId: z.number().int(), role: z.enum(["admin", "office", "field"]) }))
    .handler(async ({ input, context }) => {
      const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, input.profileId));
      if (!profile) throw new ORPCError("NOT_FOUND", { message: "Person not found" });

      const wasAdmin = normaliseRole(profile.role) === "admin";
      if (wasAdmin && input.role !== "admin") {
        if (profile.userId === context.actor.userId) {
          throw new ORPCError("BAD_REQUEST", { message: "You can't change your own access, you'd lock yourself out." });
        }
        await assertAnotherAdmin(profile.id);
      }

      const changed = await db
        .update(schema.profiles)
        .set({
          role: input.role,
          canSeeCosts: input.role === "office" ? profile.canSeeCosts : false,
          updatedAt: new Date(),
        })
        .where(
          wasAdmin && input.role !== "admin"
            ? and(eq(schema.profiles.id, profile.id), anotherActiveAdmin(profile.id))
            : eq(schema.profiles.id, profile.id),
        )
        .returning({ id: schema.profiles.id });
      if (!changed.length) throw new ORPCError("BAD_REQUEST", { message: "There must always be at least one active Admin." });

      if (input.role === "field") {
        await ensureInstallerCard(profile.userId);
      } else if (profile.installerId) {
        await db
          .update(schema.installers)
          .set({ active: false, archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.installers.id, profile.installerId));
      }
      return { ok: true as const };
    }),

  /** Office only: let this person see cost prices and margins. */
  setCostAccess: adminOnly
    .input(z.object({ profileId: z.number().int(), canSeeCosts: z.boolean() }))
    .handler(async ({ input }) => {
      const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, input.profileId));
      if (!profile) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
      if (normaliseRole(profile.role) !== "office") {
        throw new ORPCError("BAD_REQUEST", { message: "This switch only applies to Office. Admin always sees costs and Field crew never do." });
      }
      await db.update(schema.profiles).set({ canSeeCosts: input.canSeeCosts, updatedAt: new Date() }).where(eq(schema.profiles.id, profile.id));
      return { ok: true as const };
    }),

  /**
   * Name, phone and email. The email is the sign-in email, so it changes on
   * the login itself as well as the profile, and it must not belong to anyone
   * else. The installer card follows.
   */
  updatePerson: adminOnly
    .input(
      z.object({
        profileId: z.number().int(),
        name: z.string().trim().min(1).optional(),
        phone: z.string().nullable().optional(),
        email: emailShape.optional(),
      }),
    )
    .handler(async ({ input }) => {
      const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, input.profileId));
      if (!profile) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
      const { profileId, ...rest } = input;
      const email = rest.email !== undefined ? cleanEmail(rest.email) : undefined;

      if (email !== undefined) {
        const [login] = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, profile.userId));
        if (login && cleanEmail(login.email) !== email) {
          if (await emailTaken(email, profile.userId)) {
            throw new ORPCError("BAD_REQUEST", { message: `${email} is already someone else's sign-in email.` });
          }
          await db.update(schema.user).set({ email, updatedAt: new Date() }).where(eq(schema.user.id, profile.userId));
        }
      }
      if (rest.name !== undefined) {
        await db.update(schema.user).set({ name: rest.name, updatedAt: new Date() }).where(eq(schema.user.id, profile.userId));
      }

      await db
        .update(schema.profiles)
        .set({
          ...(rest.name !== undefined ? { name: rest.name } : {}),
          ...(rest.phone !== undefined ? { phone: rest.phone } : {}),
          ...(email !== undefined ? { email } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.profiles.id, profileId));
      if (profile.installerId) {
        await db
          .update(schema.installers)
          .set({
            ...(rest.name !== undefined ? { name: rest.name } : {}),
            ...(rest.phone !== undefined ? { mobile: rest.phone } : {}),
            ...(email !== undefined ? { email } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.installers.id, profile.installerId));
      }
      return { ok: true as const };
    }),

  /** Cards an Add person for Field crew can be put onto, so their history comes with them. */
  unlinkedCards: adminOnly.handler(() => unlinkedCards()),

  /**
   * Add a person with a login (notes 18.55). No password is made here: the
   * login has none until the person picks one from their invite link, so the
   * office never sees it. Field crew also get an installer card: either a new
   * one, or an existing card that has no login yet.
   *
   * The invite goes straight after. If it does not go, the person is kept
   * (there is nothing anyone can sign in with) and the reason comes back, so
   * the office can fix the mobile or email and press Send invite again.
   */
  addPerson: adminOnly
    .input(
      z.object({
        name: z.string().trim().min(1, "Add their name."),
        email: emailShape,
        mobile: z.string().trim().optional().default(""),
        role: z.enum(["admin", "office", "field"]),
        installerId: z.number().int().nullable().optional(),
        sendBy: z.enum(["sms", "email", "none"]).default("sms"),
      }),
    )
    .handler(async ({ input, context }) => {
      const email = cleanEmail(input.email);
      const phone = input.mobile.trim();
      if (input.sendBy === "sms") {
        if (!phone) throw new ORPCError("BAD_REQUEST", { message: "Add their mobile. The invite is texted to it." });
        if (!normaliseMobile(phone)) throw new ORPCError("BAD_REQUEST", { message: "That mobile does not look like an Australian mobile. The invite is texted to it." });
        if (!smsConfigured()) throw new ORPCError("BAD_REQUEST", { message: "Texting is not set up, so the invite cannot be texted. Send it by email instead." });
      } else if (phone && !normaliseMobile(phone)) {
        throw new ORPCError("BAD_REQUEST", { message: "That mobile does not look like an Australian mobile." });
      }
      if (input.sendBy === "email" && !emailConfigured()) {
        throw new ORPCError("BAD_REQUEST", { message: "Email is not set up, so the invite cannot be emailed. Send it by text instead." });
      }
      if (await emailTaken(email)) throw new ORPCError("BAD_REQUEST", { message: `${email} already has a login.` });

      let card: Awaited<ReturnType<typeof unlinkedCards>>[number] | undefined;
      if (input.installerId != null) {
        if (input.role !== "field") throw new ORPCError("BAD_REQUEST", { message: "Only Field crew go on an installer card." });
        card = (await unlinkedCards()).find((c) => c.id === input.installerId);
        if (!card) throw new ORPCError("BAD_REQUEST", { message: "That installer card already has a login, or is archived." });
      }

      const userId = randomUUID().replace(/-/g, "");
      const now = new Date();

      await db.insert(schema.user).values({ id: userId, name: input.name, email, emailVerified: false, createdAt: now, updatedAt: now });
      const undo: (() => Promise<unknown>)[] = [() => db.delete(schema.user).where(eq(schema.user.id, userId))];
      let profileId: number;
      try {
        const [profile] = await db
          .insert(schema.profiles)
          .values({ userId, name: input.name, email, phone: phone || null, role: input.role, canSeeCosts: false })
          .returning({ id: schema.profiles.id });
        profileId = profile!.id;
        undo.unshift(() => db.delete(schema.profiles).where(eq(schema.profiles.userId, userId)));

        if (card) {
          const before = card;
          await db
            .update(schema.installers)
            .set({ userId, mobile: phone || before.mobile, email, active: true, updatedAt: now })
            .where(eq(schema.installers.id, card.id));
          await db.update(schema.profiles).set({ installerId: card.id }).where(eq(schema.profiles.userId, userId));
          undo.unshift(() =>
            db
              .update(schema.installers)
              .set({ userId: null, mobile: before.mobile, email: before.email })
              .where(eq(schema.installers.id, before.id)),
          );
        } else if (input.role === "field") {
          const id = await ensureInstallerCard(userId);
          undo.unshift(() => db.delete(schema.installers).where(eq(schema.installers.id, id)));
        }
      } catch (e) {
        for (const step of undo) await step().catch(() => {});
        throw e;
      }

      if (input.sendBy === "none") return { ok: true as const, profileId, invite: null };
      try {
        const sent = await sendInvite(profileId, input.sendBy, context.actor.name || context.actor.email || "Admin");
        return {
          ok: true as const,
          profileId,
          invite: sent.ok ? { ok: true as const, to: sent.to } : { ok: false as const, reason: sent.reason },
        };
      } catch (e) {
        return { ok: true as const, profileId, invite: { ok: false as const, reason: (e as Error).message || "Not sent" } };
      }
    }),

  /** Switch a login off without deleting it. History stays attached. */
  setActive: adminOnly
    .input(z.object({ profileId: z.number().int(), active: z.boolean() }))
    .handler(async ({ input, context }) => {
      const [profile] = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.id, input.profileId));
      if (!profile) throw new ORPCError("NOT_FOUND", { message: "Login not found" });
      if (!input.active && normaliseRole(profile.role) === "admin") await assertAnotherAdmin(profile.id);
      if (profile.userId === context.actor.userId && !input.active) {
        throw new ORPCError("BAD_REQUEST", {
          message: "You can't switch off your own login.",
        });
      }

      const guardAdmin = !input.active && normaliseRole(profile.role) === "admin";
      const [updated] = await db
        .update(schema.profiles)
        .set({ active: input.active })
        .where(
          guardAdmin
            ? and(eq(schema.profiles.id, input.profileId), anotherActiveAdmin(input.profileId))
            : eq(schema.profiles.id, input.profileId),
        )
        .returning();
      if (!updated) throw new ORPCError("BAD_REQUEST", { message: "There must always be at least one active Admin." });
      // Switched off locks the login out at once: every request from it gets
      // "Account disabled" (middleware/auth.ts), and the crew phone then lets
      // go of its saved login and says the office switched it off. The session
      // rows are left alone so Last seen still shows (notes 18.63).
      return updated;
    }),
};
