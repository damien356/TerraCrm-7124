import { z } from "zod";
import { desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, mainAdminOnly, normaliseRole, restorerOnly } from "../middleware/auth";
import {
  archivePerson,
  deletePerson,
  historyOf,
  isArchived,
  resolvePerson,
  restorePerson,
  sayHistory,
  upcomingBookings,
  type PersonRef,
} from "../lib/people-archive";

/**
 * Archive, restore and delete people (Damien, 30 Oct). Spread into `team`, so
 * the client calls these as orpc.team.archive and so on. The rules live in
 * lib/people-archive.ts.
 */

const personRef = z.union([z.object({ profileId: z.number().int() }), z.object({ installerId: z.number().int() })]);

/** Card ids that belong to a login, as its crew card or its staff card. */
async function cardsWithLogin() {
  const used = new Set<number>();
  for (const r of await db.select({ id: schema.profiles.installerId }).from(schema.profiles)) if (r.id != null) used.add(r.id);
  for (const r of await db.select({ id: schema.staffCards.installerId }).from(schema.staffCards)) used.add(r.id);
  return used;
}

export const teamArchive = {
  /** Installer cards nobody logs in with. Archived ones are on the Archived people page instead. */
  cardsWithoutLogin: adminOnly.handler(async () => {
    const used = await cardsWithLogin();
    const cards = await db
      .select({
        id: schema.installers.id,
        name: schema.installers.name,
        mobile: schema.installers.mobile,
        email: schema.installers.email,
        active: schema.installers.active,
        createdAt: schema.installers.createdAt,
      })
      .from(schema.installers)
      .where(isNull(schema.installers.archivedAt))
      .orderBy(schema.installers.name);
    return cards
      .filter((c) => !used.has(c.id))
      .map((c) => ({ ...c, createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : null }));
  }),

  /**
   * What would happen: whether they can be deleted (no past work) or only
   * archived, and the bookings still ahead of them. Read only.
   */
  personCheck: mainAdminOnly.input(personRef).handler(async ({ input }) => {
    const p = await resolvePerson(input as PersonRef);
    const history = await historyOf(p);
    return {
      name: p.name,
      hasLogin: Boolean(p.profile),
      isMainAdmin: Boolean(p.profile?.isMainAdmin),
      archived: isArchived(p),
      canDelete: history.length === 0 && !p.profile?.isMainAdmin,
      history,
      historyText: history.length ? sayHistory(history) : "",
      upcoming: await upcomingBookings(p.cards.map((c) => c.id)),
    };
  }),

  /** Main admin only. Login off at once, out of booking and offers, everything kept. */
  archive: mainAdminOnly.input(personRef).handler(async ({ input, context }) => {
    const p = await resolvePerson(input as PersonRef);
    return archivePerson(p, context.actor);
  }),

  /** Main admin only, and only for someone with no past work. */
  deletePerson: mainAdminOnly.input(personRef).handler(async ({ input, context }) => {
    const p = await resolvePerson(input as PersonRef);
    return deletePerson(p, context.actor);
  }),

  /** Main admin ticks Office (or another Admin) people who may bring archived people back. */
  setCanRestore: mainAdminOnly
    .input(z.object({ profileId: z.number().int(), canRestorePeople: z.boolean() }))
    .handler(async ({ input }) => {
      const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, input.profileId));
      if (!profile) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
      if (profile.isMainAdmin) throw new ORPCError("BAD_REQUEST", { message: "The main admin can always restore people." });
      if (normaliseRole(profile.role) === "field") {
        throw new ORPCError("BAD_REQUEST", { message: "Only Office and Admin people can be given this." });
      }
      await db
        .update(schema.profiles)
        .set({ canRestorePeople: input.canRestorePeople, updatedAt: new Date() })
        .where(eq(schema.profiles.id, profile.id));
      return { ok: true as const };
    }),

  /** Everyone archived: logins, and installer cards with no login. */
  archivedList: restorerOnly.handler(async () => {
    const logins = await db
      .select()
      .from(schema.profiles)
      .where(isNotNull(schema.profiles.archivedAt))
      .orderBy(desc(schema.profiles.archivedAt));
    const used = await cardsWithLogin();
    const cards = (
      await db
        .select()
        .from(schema.installers)
        .where(isNotNull(schema.installers.archivedAt))
        .orderBy(desc(schema.installers.archivedAt))
    ).filter((c) => !used.has(c.id));
    const crewIds = logins.map((l) => l.installerId).filter((v): v is number => v != null);
    const crewNames = new Map(
      (crewIds.length ? await db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers).where(inArray(schema.installers.id, crewIds)) : []).map(
        (c) => [c.id, c.name],
      ),
    );
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    return [
      ...logins.map((l) => ({
        key: `p${l.id}`,
        profileId: l.id as number | null,
        installerId: l.installerId,
        name: l.name || l.email || "No name",
        email: l.email || null,
        mobile: l.phone ?? null,
        role: normaliseRole(l.role) as "admin" | "office" | "field" | "card",
        cardName: l.installerId ? (crewNames.get(l.installerId) ?? null) : null,
        archivedAt: iso(l.archivedAt),
        archivedByName: l.archivedByName,
      })),
      ...cards.map((c) => ({
        key: `i${c.id}`,
        profileId: null as number | null,
        installerId: c.id as number | null,
        name: c.name,
        email: c.email,
        mobile: c.mobile,
        role: "card" as const,
        cardName: c.name as string | null,
        archivedAt: iso(c.archivedAt),
        archivedByName: c.archivedByName,
      })),
    ].sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  }),

  /** Main admin, or someone ticked "Can restore people". Only the main admin can bring back an Admin. */
  restore: restorerOnly.input(personRef).handler(async ({ input, context }) => {
    const p = await resolvePerson(input as PersonRef);
    return restorePerson(p, context.actor);
  }),
};
