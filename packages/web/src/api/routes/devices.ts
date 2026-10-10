import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, authed, withUser } from "../middleware/auth";
import { pushToInstaller, sendPush } from "../lib/push";

/**
 * THE NATIVE APP'S OWN ROUTES.
 *
 * One app serves both sides of Terra. `whoami` is what the app asks first: the
 * role on the login decides which tabs it draws, and the server still gates
 * every route behind admin or installer regardless of what the app shows.
 *
 * Device tokens live here too. The phone hands its Expo push token over after
 * sign-in, and it is retired on sign-out so a handed-on phone stops getting
 * someone else's jobs.
 */
const PROBLEM_KINDS = ["fatal", "error", "screen", "storage_reset", "safe_start", "emergency_launch", "session_expired"] as const;

/** Phone problems sit in the activity log under this type. No table of their own. */
const PROBLEM_TYPE = "app_problem";

/** Most problems Ops keeps from all phones in an hour. A phone stuck in a loop cannot fill the log. */
const PROBLEMS_PER_HOUR = 120;

const short = (max: number) => z.string().max(max * 4).transform((v) => v.slice(0, max));

export const devices = {
  /** Who is signed in on this phone, and therefore what the app may show. */
  whoami: authed.handler(async ({ context }) => {
    const actor = context.actor;

    let installerName: string | null = null;
    if (actor.installerId) {
      const [installer] = await db
        .select({ name: schema.installers.name })
        .from(schema.installers)
        .where(eq(schema.installers.id, actor.installerId));
      installerName = installer?.name ?? null;
    }

    return {
      userId: actor.userId,
      name: actor.name,
      email: actor.email,
      role: actor.role,
      installerId: actor.installerId,
      installerName,
      /** The office screens are allowed. */
      canSeeOffice: actor.role !== "field",
      /** The crew screens have an installer card behind them to load. */
      canSeeField: actor.installerId !== null,
    };
  }),

  /** The phone registers itself for push. Safe to call on every app start. */
  registerDevice: authed
    .input(
      z.object({
        token: z.string().min(10),
        platform: z.enum(["ios", "android", "web"]).default("ios"),
        deviceName: z.string().default(""),
        appVersion: z.string().default(""),
      }),
    )
    .handler(async ({ input, context }) => {
      const [existing] = await db
        .select()
        .from(schema.deviceTokens)
        .where(eq(schema.deviceTokens.token, input.token));

      if (existing) {
        await db
          .update(schema.deviceTokens)
          .set({
            userId: context.actor.userId,
            platform: input.platform,
            deviceName: input.deviceName,
            appVersion: input.appVersion,
            active: true,
            lastSeenAt: new Date(),
          })
          .where(eq(schema.deviceTokens.id, existing.id));
        return { id: existing.id, registered: true };
      }

      const [created] = await db
        .insert(schema.deviceTokens)
        .values({
          userId: context.actor.userId,
          token: input.token,
          platform: input.platform,
          deviceName: input.deviceName,
          appVersion: input.appVersion,
        })
        .returning();

      return { id: created!.id, registered: true };
    }),

  /** Sign-out, or the phone changing hands. The token stops being pushed to. */
  unregisterDevice: authed
    .input(z.object({ token: z.string().min(10) }))
    .handler(async ({ input }) => {
      await db
        .update(schema.deviceTokens)
        .set({ active: false })
        .where(eq(schema.deviceTokens.token, input.token));
      return { ok: true };
    }),

  /** My own phones, so someone can see which devices are signed in as them. */
  myDevices: authed.handler(async ({ context }) =>
    db
      .select({
        id: schema.deviceTokens.id,
        platform: schema.deviceTokens.platform,
        deviceName: schema.deviceTokens.deviceName,
        appVersion: schema.deviceTokens.appVersion,
        active: schema.deviceTokens.active,
        lastSeenAt: schema.deviceTokens.lastSeenAt,
      })
      .from(schema.deviceTokens)
      .where(eq(schema.deviceTokens.userId, context.actor.userId))
      .orderBy(desc(schema.deviceTokens.lastSeenAt)),
  ),

  /** Every signed-in phone, for the office. */
  allDevices: adminOnly.handler(() =>
    db
      .select({
        id: schema.deviceTokens.id,
        userId: schema.deviceTokens.userId,
        platform: schema.deviceTokens.platform,
        deviceName: schema.deviceTokens.deviceName,
        appVersion: schema.deviceTokens.appVersion,
        active: schema.deviceTokens.active,
        lastSeenAt: schema.deviceTokens.lastSeenAt,
        name: schema.profiles.name,
        email: schema.profiles.email,
        role: schema.profiles.role,
      })
      .from(schema.deviceTokens)
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.deviceTokens.userId))
      .where(eq(schema.deviceTokens.active, true))
      .orderBy(desc(schema.deviceTokens.lastSeenAt)),
  ),

  /** A test buzz to my own phones, for checking push actually works. */
  testPush: authed.handler(async ({ context }) => {
    const sent = await sendPush([context.actor.userId], {
      title: "Terra Ops",
      body: "Push is working on this phone.",
      data: { kind: "test" },
    });
    return { sent };
  }),

  /** The office pinging one installer's phone directly. */
  pushInstaller: adminOnly
    .input(
      z.object({
        installerId: z.number(),
        title: z.string().min(1).default("Terra Ops"),
        body: z.string().min(1),
        taskId: z.number().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const sent = await pushToInstaller(input.installerId, {
        title: input.title,
        body: input.body,
        data: input.taskId ? { kind: "task", taskId: input.taskId } : { kind: "message" },
      });
      return { sent };
    }),

  /**
   * A phone sending in what went wrong on it: a crash, a screen that broke, a
   * saved login it could not read. Works signed out, because a login problem
   * is when this matters most. Kept in the activity log for Admin to read.
   */
  reportProblem: withUser
    .input(
      z.object({
        app: z.object({
          platform: short(20),
          osVersion: short(40).default(""),
          appVersion: short(40).default(""),
          updateId: short(80).nullish(),
          runtimeVersion: short(80).nullish(),
          deviceName: short(80).nullish(),
        }),
        problems: z
          .array(
            z.object({
              kind: z.enum(PROBLEM_KINDS),
              message: short(300),
              stack: short(1200).optional(),
              at: short(40),
            }),
          )
          .min(1)
          .max(10),
      }),
    )
    .handler(async ({ input, context }) => {
      const hourAgo = new Date(Date.now() - 3600_000);
      const [recent] = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.activityLog)
        .where(and(eq(schema.activityLog.entityType, PROBLEM_TYPE), gte(schema.activityLog.createdAt, hourAgo)));
      const room = Math.max(0, PROBLEMS_PER_HOUR - Number(recent?.n ?? 0));
      // Say it was received either way: the phone should not keep resending.
      if (room === 0) return { kept: 0 };

      const actor = context.actor;
      const a = input.app;
      const phone = [
        a.platform,
        a.osVersion && `OS ${a.osVersion}`,
        a.appVersion && `app ${a.appVersion}`,
        a.updateId ? `update ${a.updateId}` : "built-in copy",
        a.deviceName,
      ]
        .filter(Boolean)
        .join(" · ");
      const rows = input.problems.slice(0, room).map((p) => ({
        entityType: PROBLEM_TYPE,
        action: p.kind,
        detail: JSON.stringify({ message: p.message, stack: p.stack ?? "", at: p.at, phone, runtime: a.runtimeVersion ?? "" }),
        actorName: actor?.name || actor?.email || "Phone, signed out",
        actorRole: actor?.role ?? "system",
      }));
      await db.insert(schema.activityLog).values(rows);
      return { kept: rows.length };
    }),

  /** What phones have sent in lately, newest first. Admin only. */
  problems: adminOnly
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).default({ limit: 50 }))
    .handler(async ({ input }) => {
      const rows = await db
        .select()
        .from(schema.activityLog)
        .where(eq(schema.activityLog.entityType, PROBLEM_TYPE))
        .orderBy(desc(schema.activityLog.id))
        .limit(input.limit);
      return rows.map((r) => {
        let d: { message?: string; stack?: string; at?: string; phone?: string; runtime?: string } = {};
        try {
          d = JSON.parse(r.detail) as typeof d;
        } catch {
          d = { message: r.detail };
        }
        return {
          id: r.id,
          kind: r.action,
          message: d.message ?? "",
          stack: d.stack ?? "",
          happenedAt: d.at ?? null,
          receivedAt: r.createdAt,
          phone: d.phone ?? "",
          who: r.actorName,
          role: r.actorRole,
        };
      });
    }),
};
