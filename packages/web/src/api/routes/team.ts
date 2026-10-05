import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, ensureInstallerCard, normaliseRole } from "../middleware/auth";

/** There must always be at least one active Admin besides this person. */
async function assertAnotherAdmin(exceptProfileId: number) {
  const rows = await db.select().from(schema.profiles).where(eq(schema.profiles.active, true));
  const others = rows.filter((r) => r.id !== exceptProfileId && normaliseRole(r.role) === "admin");
  if (!others.length) throw new ORPCError("BAD_REQUEST", { message: "There must always be at least one active Admin." });
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
        seenAt: sql<number>`max(${schema.session.createdAt})`.as("seen_at"),
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

      await db
        .update(schema.profiles)
        .set({
          role: input.role,
          canSeeCosts: input.role === "office" ? profile.canSeeCosts : false,
          updatedAt: new Date(),
        })
        .where(eq(schema.profiles.id, profile.id));

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

  /** Name, phone and email live on the login. The installer card follows. */
  updatePerson: adminOnly
    .input(
      z.object({
        profileId: z.number().int(),
        name: z.string().min(1).optional(),
        phone: z.string().nullable().optional(),
        email: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, input.profileId));
      if (!profile) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
      const { profileId, ...rest } = input;
      await db.update(schema.profiles).set({ ...rest, updatedAt: new Date() }).where(eq(schema.profiles.id, profileId));
      if (profile.installerId) {
        await db
          .update(schema.installers)
          .set({
            ...(rest.name !== undefined ? { name: rest.name } : {}),
            ...(rest.phone !== undefined ? { mobile: rest.phone } : {}),
            ...(rest.email !== undefined ? { email: rest.email || null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.installers.id, profile.installerId));
      }
      return { ok: true as const };
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

      const [updated] = await db
        .update(schema.profiles)
        .set({ active: input.active })
        .where(eq(schema.profiles.id, input.profileId))
        .returning();
      return updated!;
    }),
};
