import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { base } from "../__core/app";
import { auth } from "../auth";
import { db } from "../database";
import * as schema from "../database/schema";

export type Role = "admin" | "installer";

export interface Actor {
  userId: string;
  name: string;
  email: string;
  role: Role;
  installerId: number | null;
}

async function resolveActor(headers: Headers): Promise<Actor | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;

  const [profile] = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.userId, session.user.id));

  // First user to ever sign in becomes the admin — after that, new signups
  // default to installer and must be linked to an installer record by an admin.
  if (!profile) {
    const existing = await db.select({ id: schema.profiles.id }).from(schema.profiles).limit(1);
    const role: Role = existing.length === 0 ? "admin" : "installer";
    const [created] = await db
      .insert(schema.profiles)
      .values({
        userId: session.user.id,
        name: session.user.name ?? "",
        email: session.user.email ?? "",
        role,
      })
      .returning();
    return {
      userId: session.user.id,
      name: created!.name,
      email: created!.email,
      role,
      installerId: null,
    };
  }

  if (!profile.active) throw new ORPCError("FORBIDDEN", { message: "Account disabled" });

  return {
    userId: profile.userId,
    name: profile.name || (session.user.name ?? ""),
    email: profile.email || (session.user.email ?? ""),
    role: profile.role === "admin" ? "admin" : "installer",
    installerId: profile.installerId ?? null,
  };
}

/** Optional auth — `context.actor` is the resolved actor or null. */
export const withUser = base.use(async ({ context, next }) => {
  const actor = await resolveActor(context.headers);
  return next({ context: { actor } });
});

/** Any signed-in user. */
export const authed = base.use(async ({ context, next }) => {
  const actor = await resolveActor(context.headers);
  if (!actor) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { actor } });
});

/** Office/admin only — everything to do with money, quotes and other people's work. */
export const adminOnly = base.use(async ({ context, next }) => {
  const actor = await resolveActor(context.headers);
  if (!actor) throw new ORPCError("UNAUTHORIZED");
  if (actor.role !== "admin") {
    throw new ORPCError("FORBIDDEN", { message: "Admin access required" });
  }
  return next({ context: { actor } });
});

/**
 * Installer-scoped procedures. `context.installerId` is guaranteed non-null, and
 * every query built on this base MUST filter by it — installers can only ever
 * read their own tasks and offers. Admins are allowed through for testing with
 * an explicit installer link.
 */
export const installerOnly = base.use(async ({ context, next }) => {
  const actor = await resolveActor(context.headers);
  if (!actor) throw new ORPCError("UNAUTHORIZED");
  if (!actor.installerId) {
    throw new ORPCError("FORBIDDEN", {
      message: "This login isn't linked to an installer record yet.",
    });
  }
  return next({ context: { actor, installerId: actor.installerId } });
});
