import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, authed } from "../middleware/auth";
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
      canSeeOffice: actor.role === "admin",
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
};
