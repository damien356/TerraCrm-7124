import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { base } from "../__core/app";
import { db } from "../database";
import * as schema from "../database/schema";
import { normaliseRole, resolveActor } from "./auth";

/**
 * Siri runs while the Terra app is closed and the phone is in a pocket, so it
 * cannot lean on the app's sign-in. Each phone gets its own voice key instead,
 * sent as `x-terra-voice-key`. Only a sha256 of it is stored, and the office can
 * revoke one phone without signing anyone out.
 *
 * A normal signed-in session works too, so the app itself (and the tests) can
 * call the same procedures.
 */
export const VOICE_KEY_HEADER = "x-terra-voice-key";

export const hashSecret = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** A new key. Shown once to the phone that asked for it, never again. */
export const newVoiceKey = () => `tvk_${randomBytes(32).toString("base64url")}`;

/** One time confirm codes for "Send it?". */
export const newConfirmToken = () => `tvc_${randomBytes(24).toString("base64url")}`;

export const crewVoice = base.use(async ({ context, next }) => {
  const raw = context.headers.get(VOICE_KEY_HEADER)?.trim();
  if (raw) {
    const [row] = await db
      .select({
        id: schema.voiceKeys.id,
        installerId: schema.voiceKeys.installerId,
        userId: schema.voiceKeys.userId,
        lastUsedAt: schema.voiceKeys.lastUsedAt,
        installerActive: schema.installers.active,
        installerName: schema.installers.name,
      })
      .from(schema.voiceKeys)
      .innerJoin(schema.installers, eq(schema.installers.id, schema.voiceKeys.installerId))
      .where(and(eq(schema.voiceKeys.keyHash, hashSecret(raw)), isNull(schema.voiceKeys.revokedAt)));
    if (!row || !row.installerActive) throw new ORPCError("UNAUTHORIZED", { message: "This phone's Siri key is not valid." });

    /* The login behind the key must still be live and still be this installer. */
    const [profile] = await db
      .select({ active: schema.profiles.active, installerId: schema.profiles.installerId, role: schema.profiles.role })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, row.userId));
    if (!profile?.active || normaliseRole(profile.role) !== "field" || profile.installerId !== row.installerId) {
      throw new ORPCError("UNAUTHORIZED", { message: "This phone's Siri key is not valid." });
    }

    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 5 * 60_000) {
      await db.update(schema.voiceKeys).set({ lastUsedAt: new Date() }).where(eq(schema.voiceKeys.id, row.id));
    }
    return next({
      context: { installerId: row.installerId, installerName: row.installerName, voiceKeyId: row.id as number | null },
    });
  }

  const actor = await resolveActor(context.headers);
  if (!actor) throw new ORPCError("UNAUTHORIZED");
  if (actor.role !== "field" || !actor.installerId) {
    throw new ORPCError("FORBIDDEN", { message: "This login isn't linked to an installer record yet." });
  }
  const [inst] = await db
    .select({ name: schema.installers.name })
    .from(schema.installers)
    .where(eq(schema.installers.id, actor.installerId));
  return next({
    context: { installerId: actor.installerId, installerName: inst?.name ?? actor.name, voiceKeyId: null as number | null },
  });
});
