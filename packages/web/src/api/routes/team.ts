import { z } from "zod";
import { asc, desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";

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
      role: r.profile.role === "admin" ? ("admin" as const) : ("installer" as const),
      active: r.profile.active,
      installerId: r.profile.installerId,
      installerName: r.installerName ?? null,
      installerActive: r.installerActive ?? null,
      signedUpAt: r.signedUpAt ? new Date(Number(r.signedUpAt)).toISOString() : null,
      lastSeenAt: r.lastSeenAt ? new Date(Number(r.lastSeenAt)).toISOString() : null,
    }));
  }),

  /** Installer cards with no login attached yet — the other half of the link. */
  unlinkedInstallers: adminOnly.handler(async () => {
    const linked = await db
      .select({ installerId: schema.profiles.installerId })
      .from(schema.profiles);
    const taken = new Set(linked.map((l) => l.installerId).filter((id): id is number => id !== null));

    const rows = await db
      .select({ id: schema.installers.id, name: schema.installers.name, mobile: schema.installers.mobile })
      .from(schema.installers)
      .where(eq(schema.installers.active, true))
      .orderBy(asc(schema.installers.name));

    return rows.filter((r) => !taken.has(r.id));
  }),

  /** Point a login at an installer card — or unhook it with installerId null. */
  link: adminOnly
    .input(z.object({ profileId: z.number().int(), installerId: z.number().int().nullable() }))
    .handler(async ({ input }) => {
      const [profile] = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.id, input.profileId));
      if (!profile) throw new ORPCError("NOT_FOUND", { message: "Login not found" });

      if (input.installerId !== null) {
        const [installer] = await db
          .select({ id: schema.installers.id })
          .from(schema.installers)
          .where(eq(schema.installers.id, input.installerId));
        if (!installer) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });

        const clash = await db
          .select({ id: schema.profiles.id, email: schema.profiles.email })
          .from(schema.profiles)
          .where(eq(schema.profiles.installerId, input.installerId));
        const other = clash.find((c) => c.id !== input.profileId);
        if (other) {
          throw new ORPCError("CONFLICT", {
            message: `That installer is already linked to ${other.email || "another login"}.`,
          });
        }
      }

      const [updated] = await db
        .update(schema.profiles)
        .set({ installerId: input.installerId })
        .where(eq(schema.profiles.id, input.profileId))
        .returning();
      return updated!;
    }),

  /** Office access or field access. Nobody can demote their own login. */
  setRole: adminOnly
    .input(z.object({ profileId: z.number().int(), role: z.enum(["admin", "installer"]) }))
    .handler(async ({ input, context }) => {
      const [profile] = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.id, input.profileId));
      if (!profile) throw new ORPCError("NOT_FOUND", { message: "Login not found" });
      if (profile.userId === context.actor.userId && input.role !== "admin") {
        throw new ORPCError("BAD_REQUEST", {
          message: "You can't take admin off your own login — you'd lock yourself out.",
        });
      }

      const [updated] = await db
        .update(schema.profiles)
        .set({ role: input.role })
        .where(eq(schema.profiles.id, input.profileId))
        .returning();
      return updated!;
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
