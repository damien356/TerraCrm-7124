import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { authed, normaliseRole, staffOnly, type Actor } from "../middleware/auth";
import { isMeasureSkill } from "../lib/property-types";
import {
  calendarConnectUrl,
  calendarOauthConfigured,
  disconnectCalendar,
  listCalendars,
  safeCalendars,
  safeIds,
} from "../lib/google-calendar";
import { BOARD_FRESH_MS, boardBlocks, checkAttendance, linkProblem, refreshLink } from "../lib/calendar-availability";

/* ---------------------------------------------------------------------------
 * Bookable staff and their Google calendars (Damien, 30 Oct).
 *
 * Every write here is about the signed-in person's own time. Nobody can
 * connect, tick calendars or change buffers for someone else. An Admin can
 * make another Office or Admin person bookable, but only that person can
 * link their calendar.
 * ------------------------------------------------------------------------- */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/);

async function myProfile(actor: Actor) {
  const [p] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, actor.userId));
  if (!p) throw new ORPCError("NOT_FOUND", { message: "Your login has no Terra Ops profile." });
  return p;
}

/** The card this profile is booked on: a crew card for Field, a staff card for Office and Admin. */
async function cardOf(profile: typeof schema.profiles.$inferSelect) {
  if (normaliseRole(profile.role) === "field") return profile.installerId ?? null;
  const [s] = await db.select().from(schema.staffCards).where(eq(schema.staffCards.profileId, profile.id));
  return s?.installerId ?? null;
}

async function myLink(actor: Actor) {
  const profile = await myProfile(actor);
  const installerId = await cardOf(profile);
  if (!installerId) throw new ORPCError("BAD_REQUEST", { message: "Make yourself bookable first." });
  const [link] = await db.select().from(schema.calendarLinks).where(eq(schema.calendarLinks.installerId, installerId));
  return { profile, installerId, link: link ?? null };
}

/** Creates a staff card for an Office or Admin person, ticked for measures and site visits. */
async function makeCard(profile: typeof schema.profiles.$inferSelect) {
  if (normaliseRole(profile.role) === "field") {
    throw new ORPCError("BAD_REQUEST", { message: "Field crew are already bookable on their own card." });
  }
  const [existing] = await db.select().from(schema.staffCards).where(eq(schema.staffCards.profileId, profile.id));
  if (existing) return existing.installerId;
  // No mobile or email on the card: crew texts and job sheets never go to an office login by accident.
  const [card] = await db
    .insert(schema.installers)
    .values({ name: profile.name || profile.email || "Office", colour: "#7A6A58", notes: "Staff card for an Office or Admin login. Booked for measures, site visits and jobs." })
    .returning({ id: schema.installers.id });
  await db.insert(schema.staffCards).values({ profileId: profile.id, installerId: card!.id });
  const skills = (await db.select({ id: schema.skills.id, name: schema.skills.name }).from(schema.skills)).filter((s) => isMeasureSkill(s.name));
  if (skills.length) await db.insert(schema.installerSkills).values(skills.map((s) => ({ installerId: card!.id, skillId: s.id })));
  return card!.id;
}

/** What one link looks like to its owner. Never the token. */
function linkView(link: typeof schema.calendarLinks.$inferSelect | null) {
  if (!link) return null;
  const problem = linkProblem(link);
  const stale = !link.lastSyncOkAt || Date.now() - link.lastSyncOkAt > BOARD_FRESH_MS;
  return {
    id: link.id,
    connected: Boolean(link.refreshTokenSealed),
    googleEmail: link.googleEmail,
    calendars: safeCalendars(link.calendarsJson),
    ticked: safeIds(link.calendarIds),
    bufferBeforeMin: link.bufferBeforeMin,
    bufferAfterMin: link.bufferAfterMin,
    lastSyncOkAt: link.lastSyncOkAt,
    lastError: link.lastError,
    /** ok, or why the person is not shown as available. */
    state: problem ? "unchecked" : link.lastError || stale ? "stale" : "ok",
    problem: problem ?? (link.lastError ? `Google could not be checked: ${link.lastError}` : null),
  };
}

export const calendar = {
  /** My bookable card and calendar link, for Settings. */
  me: authed.handler(async ({ context }) => {
    const profile = await myProfile(context.actor);
    const installerId = await cardOf(profile);
    const [link] = installerId ? await db.select().from(schema.calendarLinks).where(eq(schema.calendarLinks.installerId, installerId)) : [];
    const [card] = installerId ? await db.select({ name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, installerId)) : [];
    return {
      profileId: profile.id,
      email: profile.email,
      role: normaliseRole(profile.role),
      installerId,
      cardName: card?.name ?? null,
      googleReady: calendarOauthConfigured(),
      link: linkView(link ?? null),
    };
  }),

  /** Office and Admin people and whether each is bookable. Admin uses it to make others bookable. */
  staff: staffOnly.handler(async () => {
    const people = (await db.select().from(schema.profiles).where(eq(schema.profiles.active, true))).filter((p) => normaliseRole(p.role) !== "field");
    const cards = await db.select().from(schema.staffCards);
    const links = cards.length ? await db.select().from(schema.calendarLinks).where(inArray(schema.calendarLinks.installerId, cards.map((c) => c.installerId))) : [];
    return people.map((p) => {
      const c = cards.find((x) => x.profileId === p.id);
      const l = c ? links.find((x) => x.installerId === c.installerId) : undefined;
      return {
        profileId: p.id,
        name: p.name || p.email,
        role: normaliseRole(p.role),
        installerId: c?.installerId ?? null,
        calendar: l ? (l.refreshTokenSealed ? (linkProblem(l) ? "no_calendars" : "connected") : "not_connected") : "none",
      };
    });
  }),

  /** Makes me (or, for an Admin, another Office or Admin person) bookable. */
  makeBookable: authed.input(z.object({ profileId: z.number().int().optional() })).handler(async ({ input, context }) => {
    const me = await myProfile(context.actor);
    const targetId = input.profileId ?? me.id;
    if (targetId !== me.id && context.actor.role !== "admin") throw new ORPCError("FORBIDDEN", { message: "Only an Admin can make someone else bookable." });
    const [target] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, targetId));
    if (!target) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
    if (target.archivedAt || !target.active) throw new ORPCError("BAD_REQUEST", { message: "This person is archived or switched off, so they can't be made bookable." });
    return { installerId: await makeCard(target) };
  }),

  /** Google sign-in for MY calendar. Nobody can start this for someone else. */
  connectUrl: authed.handler(async ({ context }) => {
    const { profile, installerId, link } = await myLink(context.actor);
    let id = link?.id;
    if (!id) {
      const [made] = await db.insert(schema.calendarLinks).values({ installerId, ownerProfileId: profile.id }).returning({ id: schema.calendarLinks.id });
      id = made!.id;
    } else if (link!.ownerProfileId !== profile.id) {
      throw new ORPCError("FORBIDDEN", { message: "This calendar belongs to someone else." });
    }
    try {
      return { url: calendarConnectUrl(id, profile.id, profile.email) };
    } catch (e) {
      throw new ORPCError("BAD_REQUEST", { message: (e as Error).message });
    }
  }),

  /** Which of my calendars count as busy. */
  setCalendars: authed.input(z.object({ ids: z.array(z.string().min(1)).max(50) })).handler(async ({ input, context }) => {
    const { link } = await myLink(context.actor);
    if (!link?.refreshTokenSealed) throw new ORPCError("BAD_REQUEST", { message: "Connect your Google calendar first." });
    const known = new Set(safeCalendars(link.calendarsJson).map((c) => c.id));
    const ids = [...new Set(input.ids)].filter((id) => known.has(id));
    await db.update(schema.calendarLinks).set({ calendarIds: JSON.stringify(ids), lastSyncOkAt: null, updatedAt: new Date() }).where(eq(schema.calendarLinks.id, link.id));
    const [fresh] = await db.select().from(schema.calendarLinks).where(eq(schema.calendarLinks.id, link.id));
    if (ids.length) await refreshLink(fresh!);
    const [after] = await db.select().from(schema.calendarLinks).where(eq(schema.calendarLinks.id, link.id));
    return linkView(after ?? null);
  }),

  /** Minutes kept clear either side of each busy time. Default 15 and 15. */
  setBuffers: authed
    .input(z.object({ beforeMin: z.number().int().min(0).max(180), afterMin: z.number().int().min(0).max(180) }))
    .handler(async ({ input, context }) => {
      const { link } = await myLink(context.actor);
      if (!link) throw new ORPCError("BAD_REQUEST", { message: "Connect your Google calendar first." });
      await db
        .update(schema.calendarLinks)
        .set({ bufferBeforeMin: input.beforeMin, bufferAfterMin: input.afterMin, updatedAt: new Date() })
        .where(eq(schema.calendarLinks.id, link.id));
      return { ok: true as const };
    }),

  /** Reads my calendar names and busy times again now. */
  refresh: authed.handler(async ({ context }) => {
    const { link } = await myLink(context.actor);
    if (!link?.refreshTokenSealed) throw new ORPCError("BAD_REQUEST", { message: "Connect your Google calendar first." });
    try {
      await listCalendars(link.id);
    } catch (e) {
      await db.update(schema.calendarLinks).set({ lastError: String((e as Error).message ?? e).slice(0, 300), lastSyncTryAt: Date.now() }).where(eq(schema.calendarLinks.id, link.id));
    }
    const [mid] = await db.select().from(schema.calendarLinks).where(eq(schema.calendarLinks.id, link.id));
    if (mid) await refreshLink(mid);
    const [after] = await db.select().from(schema.calendarLinks).where(eq(schema.calendarLinks.id, link.id));
    return linkView(after ?? null);
  }),

  /**
   * Unlinks my Google calendar. The link stays, so I am still checked and
   * shown as "not checked" (never free) until I connect again or remove it.
   */
  disconnect: authed.handler(async ({ context }) => {
    const { link } = await myLink(context.actor);
    if (link) await disconnectCalendar(link.id);
    return { ok: true as const };
  }),

  /** Stops checking my calendar at all. Bookings go back to normal for me. */
  stopChecking: authed.handler(async ({ context }) => {
    const { link } = await myLink(context.actor);
    if (!link) return { ok: true as const };
    await disconnectCalendar(link.id);
    await db.delete(schema.calendarLinks).where(eq(schema.calendarLinks.id, link.id));
    return { ok: true as const };
  }),

  /** Busy shading for the schedule board. Times only, never event details. */
  board: staffOnly.input(z.object({ from: dateStr, to: dateStr })).handler(async ({ input }) => {
    if (input.to < input.from) throw new ORPCError("BAD_REQUEST", { message: "The end date is before the start date." });
    return boardBlocks(input.from, input.to);
  }),

  /** The same check a booking runs, without booking. For the booking panel. */
  check: staffOnly
    .input(
      z.object({
        taskId: z.number().int().nullable(),
        durationHours: z.number().nullable(),
        days: z
          .array(
            z.object({
              date: dateStr,
              arrivalStart: hhmm.nullable(),
              arrivalEnd: hhmm.nullable(),
              coordinate: z.boolean().default(false),
              people: z.array(z.number().int()).max(6),
            }),
          )
          .max(60),
      }),
    )
    .handler(async ({ input, context }) => checkAttendance({ ...input, actor: context.actor })),

  /** Bookings made over someone's personal commitment, newest first. */
  overrides: staffOnly.input(z.object({ installerId: z.number().int().optional(), taskId: z.number().int().optional() })).handler(async ({ input }) => {
    const where = and(
      input.installerId ? eq(schema.calendarOverrides.installerId, input.installerId) : undefined,
      input.taskId ? eq(schema.calendarOverrides.taskId, input.taskId) : undefined,
    );
    return db.select().from(schema.calendarOverrides).where(where).orderBy(desc(schema.calendarOverrides.id)).limit(100);
  }),
};
