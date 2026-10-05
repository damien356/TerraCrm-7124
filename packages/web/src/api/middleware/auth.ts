import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { base } from "../__core/app";
import { auth } from "../auth";
import { db } from "../database";
import * as schema from "../database/schema";

export type Role = "admin" | "office" | "field";

export interface Actor {
  userId: string;
  name: string;
  email: string;
  role: Role;
  installerId: number | null;
  /** Admin always true. Office only when an Admin switched it on. Field never. */
  canSeeCosts: boolean;
}

/** Old databases store "installer" for field crew. Anything unknown is treated as field (least access). */
export function normaliseRole(raw: string | null | undefined): Role {
  if (raw === "admin") return "admin";
  if (raw === "office") return "office";
  return "field";
}

/**
 * Field crew always have an installer card. Creates one from the login's
 * name, phone and email, or restores an archived one with its history.
 * Guarded so parallel requests from a new login cannot create two cards.
 */
const inflight = new Map<string, Promise<number>>();
export function ensureInstallerCard(userId: string): Promise<number> {
  const running = inflight.get(userId);
  if (running) return running;
  const p = (async () => {
    const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId));
    if (!profile) throw new ORPCError("NOT_FOUND", { message: "Login not found" });
    if (profile.installerId) {
      const [card] = await db.select().from(schema.installers).where(eq(schema.installers.id, profile.installerId));
      if (card) {
        if (card.archivedAt || !card.active) {
          await db
            .update(schema.installers)
            .set({ archivedAt: null, active: true, updatedAt: new Date() })
            .where(eq(schema.installers.id, card.id));
        }
        return card.id;
      }
    }
    const [created] = await db
      .insert(schema.installers)
      .values({
        name: profile.name || profile.email || "New crew member",
        mobile: profile.phone ?? null,
        email: profile.email || null,
        userId: profile.userId,
      })
      .returning({ id: schema.installers.id });
    await db.update(schema.profiles).set({ installerId: created!.id }).where(eq(schema.profiles.userId, userId));
    return created!.id;
  })().finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}

export async function resolveActor(headers: Headers): Promise<Actor | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;

  const [profile] = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.userId, session.user.id));

  // First user to ever sign in becomes the admin. Everyone after that signs up
  // as Field crew (and gets an installer card). An Admin can change their level.
  if (!profile) {
    const existing = await db.select({ id: schema.profiles.id }).from(schema.profiles).limit(1);
    const role: Role = existing.length === 0 ? "admin" : "field";
    const [created] = await db
      .insert(schema.profiles)
      .values({
        userId: session.user.id,
        name: session.user.name ?? "",
        email: session.user.email ?? "",
        role,
      })
      .returning();
    const installerId = role === "field" ? await ensureInstallerCard(session.user.id) : null;
    return {
      userId: session.user.id,
      name: created!.name,
      email: created!.email,
      role,
      installerId,
      canSeeCosts: role === "admin",
    };
  }

  if (!profile.active) throw new ORPCError("FORBIDDEN", { message: "Account disabled" });

  const role = normaliseRole(profile.role);
  let installerId: number | null = null;
  if (role === "field") {
    installerId = profile.installerId ?? (await ensureInstallerCard(profile.userId));
    // A restored card must be live. An archived card never grants access.
    const [card] = await db
      .select({ archivedAt: schema.installers.archivedAt })
      .from(schema.installers)
      .where(eq(schema.installers.id, installerId));
    if (card?.archivedAt) installerId = await ensureInstallerCard(profile.userId);
  }

  return {
    userId: profile.userId,
    name: profile.name || (session.user.name ?? ""),
    email: profile.email || (session.user.email ?? ""),
    role,
    installerId,
    canSeeCosts: role === "admin" || (role === "office" && profile.canSeeCosts),
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

/** Admin only: prices, costs, settings, logins, integrations and deleting records. */
export const adminOnly = base.use(async ({ context, next }) => {
  const actor = await resolveActor(context.headers);
  if (!actor) throw new ORPCError("UNAUTHORIZED");
  if (actor.role !== "admin") {
    throw new ORPCError("FORBIDDEN", { message: "Admin access required" });
  }
  return next({ context: { actor } });
});

/** Admin or Office: the day-to-day running of the business. Never Field crew. */
export const staffOnly = base.use(async ({ context, next }) => {
  const actor = await resolveActor(context.headers);
  if (!actor) throw new ORPCError("UNAUTHORIZED");
  if (actor.role === "field") {
    throw new ORPCError("FORBIDDEN", { message: "Office access required" });
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
  if (actor.role !== "field" || !actor.installerId) {
    throw new ORPCError("FORBIDDEN", {
      message: "This login is not Field crew.",
    });
  }
  return next({ context: { actor, installerId: actor.installerId } });
});
