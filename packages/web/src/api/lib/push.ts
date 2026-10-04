/* ---------------------------------------------------------------------------
 * Push notifications to the Terra Ops app, via Expo's push service.
 *
 * Same shape as lib/email.ts and lib/sms.ts: a raw sender that knows about
 * devices and nothing else. It never decides who deserves a notification, it
 * only delivers to the user ids it is handed.
 *
 * No API key is needed for Expo push in the normal case. A token is only
 * required once push security is switched on in the Expo project, and then it
 * comes from EXPO_ACCESS_TOKEN.
 * ------------------------------------------------------------------------- */

import { and, eq, inArray } from "drizzle-orm";
import { db, inDemo } from "../database";
import * as schema from "../database/schema";

const ENDPOINT = "https://exp.host/--/api/v2/push/send";

export interface PushMessage {
  title: string;
  body: string;
  /** Deep link or screen hint the app reads when the notification is tapped. */
  data?: Record<string, unknown>;
  /** Small number on the app icon. Omit to leave it alone. */
  badge?: number;
  /** default · null for silent. */
  sound?: "default" | null;
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** Live tokens for these users, newest device first. */
async function tokensFor(userIds: string[]): Promise<string[]> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await db
    .select({ token: schema.deviceTokens.token })
    .from(schema.deviceTokens)
    .where(and(inArray(schema.deviceTokens.userId, ids), eq(schema.deviceTokens.active, true)));
  return rows.map((r) => r.token);
}

/** Retires tokens Expo has told us are dead, so they stop being retried. */
async function retire(tokens: string[]) {
  if (tokens.length === 0) return;
  await db
    .update(schema.deviceTokens)
    .set({ active: false })
    .where(inArray(schema.deviceTokens.token, tokens));
}

/**
 * Sends one message to every device of every user given. Returns how many
 * devices accepted it. Never throws: a notification failing must not take down
 * the thing that triggered it.
 */
export async function sendPush(userIds: string[], message: PushMessage): Promise<number> {
  /* The Google Play reviewer's demo never pushes to any phone. */
  if (inDemo()) return 0;
  const tokens = await tokensFor(userIds);
  if (tokens.length === 0) return 0;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (process.env.EXPO_ACCESS_TOKEN) {
    headers.authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }

  let delivered = 0;
  const dead: string[] = [];

  // Expo takes up to 100 messages a call.
  for (let i = 0; i < tokens.length; i += 100) {
    const batch = tokens.slice(i, i + 100);
    const payload = batch.map((to) => ({
      to,
      title: message.title,
      body: message.body,
      data: message.data ?? {},
      sound: message.sound === null ? undefined : "default",
      badge: message.badge,
      priority: "high",
      channelId: "default",
    }));

    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as { data?: ExpoTicket[] };
      const tickets = json.data ?? [];
      tickets.forEach((ticket, index) => {
        if (ticket.status === "ok") {
          delivered += 1;
          return;
        }
        const err = ticket.details?.error;
        if (err === "DeviceNotRegistered") dead.push(batch[index]!);
      });
    } catch (error) {
      console.error("[push] send failed", error);
    }
  }

  await retire(dead);
  return delivered;
}

/** Everyone in the office. Used for anything the crew does that the office must see. */
export async function adminUserIds(): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.profiles.userId })
    .from(schema.profiles)
    .where(and(eq(schema.profiles.role, "admin"), eq(schema.profiles.active, true)));
  return rows.map((r) => r.userId);
}

/** The logins attached to an installer card, so a crew member can be reached. */
export async function userIdsForInstaller(installerId: number): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.profiles.userId })
    .from(schema.profiles)
    .where(and(eq(schema.profiles.installerId, installerId), eq(schema.profiles.active, true)));
  return rows.map((r) => r.userId);
}

/** Push to one installer by their installer card id. */
export async function pushToInstaller(installerId: number, message: PushMessage): Promise<number> {
  const users = await userIdsForInstaller(installerId);
  return sendPush(users, message);
}

/** Push to the office. */
export async function pushToOffice(message: PushMessage): Promise<number> {
  const users = await adminUserIds();
  return sendPush(users, message);
}
