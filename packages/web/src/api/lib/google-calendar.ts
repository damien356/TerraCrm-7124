import { eq } from "drizzle-orm";
import { db, inDemo } from "../database";
import * as schema from "../database/schema";
import { readState, seal, sealConfigured, signState, unseal } from "./secret-box";

/* ---------------------------------------------------------------------------
 * Google Calendar, busy times only (Damien, 30 Oct).
 *
 * Google is asked for two scopes and nothing else:
 *   calendar.freebusy               when each calendar is busy. No titles,
 *                                   descriptions, places or attendees, ever.
 *   calendar.calendarlist.readonly  the names of the person's calendars, so
 *                                   they can tick which ones count.
 * Neither can read an event or change anything.
 *
 * Same Google Cloud app as the mailboxes (GOOGLE_MAIL_CLIENT_ID), and the same
 * registered callback (/api/mail/oauth/callback): the signed state carries
 * k = "cal" so the callback knows this is a calendar sign-in.
 *
 * Every Google call can be pointed somewhere else for tests only:
 *   GOOGLE_OAUTH_TOKEN_URL, GOOGLE_CAL_API_BASE.
 * ------------------------------------------------------------------------- */

export const FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
export const CALLIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
export const CAL_SCOPES = [FREEBUSY_SCOPE, CALLIST_SCOPE];

const tokenUrl = () => process.env.GOOGLE_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const apiBase = () => (process.env.GOOGLE_CAL_API_BASE ?? "https://www.googleapis.com/calendar/v3").replace(/\/+$/, "");

export const calendarOauthConfigured = () =>
  Boolean(process.env.GOOGLE_MAIL_CLIENT_ID && process.env.GOOGLE_MAIL_CLIENT_SECRET) && sealConfigured();

/** The mailbox callback, already registered with Google. */
function redirectUri() {
  const base = (process.env.MAIL_OAUTH_BASE ?? "https://ops.terraflooring.com.au").replace(/\/+$/, "");
  return `${base}/api/mail/oauth/callback`;
}

export type CalState = { k: "cal"; l: number; p: number; em: string; e: number };

/** True when a signed state is a calendar sign-in, so the shared callback can route it. */
export function isCalendarState(state: string) {
  try {
    return readState<{ k?: string }>(state)?.k === "cal";
  } catch {
    return false;
  }
}

/** The Google sign-in address for one calendar link. Only its own owner may start it. */
export function calendarConnectUrl(linkId: number, ownerProfileId: number, email: string) {
  if (inDemo()) throw new Error("Calendars can't be connected in the demo.");
  if (!calendarOauthConfigured()) throw new Error("Google sign-in is not set up on this server.");
  const em = email.trim().toLowerCase();
  const state = signState({ k: "cal", l: linkId, p: ownerProfileId, em, e: Date.now() + 10 * 60_000 } satisfies CalState);
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_MAIL_CLIENT_ID ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: CAL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    ...(em ? { login_hint: em } : {}),
    hd: "terraflooring.com.au",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenCall(body: Record<string, string>) {
  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_MAIL_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_MAIL_CLIENT_SECRET ?? "",
      ...body,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, string | number | undefined>;
  if (!res.ok) {
    const err = new Error(String(json.error_description ?? json.error ?? `Google said ${res.status}`));
    (err as Error & { code?: string }).code = String(json.error ?? "");
    throw err;
  }
  return json as { access_token: string; refresh_token?: string; scope?: string; expires_in?: number };
}

async function revoke(token: string) {
  if (process.env.GOOGLE_OAUTH_TOKEN_URL) return; // test server, nothing to revoke
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}

async function calFetch(token: string, path: string, init?: RequestInit) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${apiBase()}/${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json as { error?: { message?: string } }).error?.message ?? `Google Calendar said ${res.status}`;
      const err = new Error(msg);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return json as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export type CalendarEntry = { id: string; name: string; primary: boolean };

async function listWith(token: string): Promise<CalendarEntry[]> {
  const out: CalendarEntry[] = [];
  let pageToken: string | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const p = new URLSearchParams({ maxResults: "250", showHidden: "false" });
    if (pageToken) p.set("pageToken", pageToken);
    const res = (await calFetch(token, `users/me/calendarList?${p}`)) as {
      items?: Array<{ id: string; summary?: string; summaryOverride?: string; primary?: boolean; deleted?: boolean }>;
      nextPageToken?: string;
    };
    for (const c of res.items ?? []) {
      if (c.deleted) continue;
      out.push({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: Boolean(c.primary) });
    }
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/**
 * The OAuth return. Checks before anything is stored: the state is ours and
 * fresh, the right person signed in, and Google granted the two calendar
 * scopes and nothing more.
 */
export async function finishCalendarConnect(code: string, state: string) {
  const s = readState<CalState>(state);
  if (!s || s.k !== "cal" || s.e < Date.now()) throw new Error("That sign-in link has expired. Start again from Schedule, My calendar.");
  const [link] = await db.select().from(schema.calendarLinks).where(eq(schema.calendarLinks.id, s.l));
  if (!link || link.ownerProfileId !== s.p) throw new Error("That calendar link no longer exists. Start again from Schedule, My calendar.");

  const tok = await tokenCall({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  const granted = (tok.scope ?? "").split(/\s+/).filter(Boolean);
  const extra = granted.filter((g) => !CAL_SCOPES.includes(g));
  const missing = CAL_SCOPES.filter((g) => !granted.includes(g));
  if (extra.length || missing.length) {
    await revoke(tok.refresh_token ?? tok.access_token);
    throw new Error(
      extra.length
        ? `Google granted more than busy times and calendar names (${extra.join(", ")}). Nothing was saved.`
        : "Google did not grant both calendar permissions. Tick both boxes and try again.",
    );
  }

  const calendars = await listWith(tok.access_token);
  const primary = calendars.find((c) => c.primary);
  const signedInAs = (primary?.id ?? "").toLowerCase();
  if (s.em && signedInAs !== s.em) {
    await revoke(tok.refresh_token ?? tok.access_token);
    throw new Error(`You signed in as ${signedInAs || "a different account"}. Sign in as ${s.em} instead.`);
  }
  if (!tok.refresh_token) throw new Error("Google did not hand back a lasting sign-in. Try connecting again.");

  // First connect ticks the main calendar only. The person picks the rest.
  const keep = safeIds(link.calendarIds).filter((id) => calendars.some((c) => c.id === id));
  const ids = keep.length ? keep : primary ? [primary.id] : [];
  await db
    .update(schema.calendarLinks)
    .set({
      googleEmail: signedInAs || null,
      refreshTokenSealed: seal(tok.refresh_token),
      scopes: granted.join(" "),
      calendarIds: JSON.stringify(ids),
      calendarsJson: JSON.stringify(calendars),
      lastError: null,
      lastSyncOkAt: null,
      cacheFrom: null,
      cacheTo: null,
      connectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.calendarLinks.id, link.id));
  accessCache.set(link.id, { token: tok.access_token, exp: Date.now() + ((tok.expires_in ?? 3600) - 120) * 1000 });
  return { linkId: link.id, email: signedInAs, calendars: calendars.length };
}

export async function disconnectCalendar(linkId: number) {
  const [row] = await db.select().from(schema.calendarLinks).where(eq(schema.calendarLinks.id, linkId));
  if (!row) return;
  if (row.refreshTokenSealed) {
    try {
      await revoke(unseal(row.refreshTokenSealed));
    } catch {
      /* already gone at Google's end, still clear ours */
    }
  }
  accessCache.delete(linkId);
  await db.delete(schema.calendarBusy).where(eq(schema.calendarBusy.linkId, linkId));
  await db
    .update(schema.calendarLinks)
    .set({ refreshTokenSealed: null, scopes: "", lastError: null, lastSyncOkAt: null, cacheFrom: null, cacheTo: null, updatedAt: new Date() })
    .where(eq(schema.calendarLinks.id, linkId));
}

/* ------------------------------ access tokens ----------------------------- */

const accessCache = new Map<number, { token: string; exp: number }>();

export class CalendarNotConnected extends Error {}

async function accessToken(linkId: number): Promise<string> {
  if (inDemo()) throw new CalendarNotConnected("Calendars are not connected in the demo");
  const hit = accessCache.get(linkId);
  if (hit && hit.exp > Date.now()) return hit.token;
  const [row] = await db.select().from(schema.calendarLinks).where(eq(schema.calendarLinks.id, linkId));
  if (!row?.refreshTokenSealed) throw new CalendarNotConnected("The Google calendar is not connected");
  try {
    const tok = await tokenCall({ grant_type: "refresh_token", refresh_token: unseal(row.refreshTokenSealed) });
    accessCache.set(linkId, { token: tok.access_token, exp: Date.now() + ((tok.expires_in ?? 3600) - 120) * 1000 });
    return tok.access_token;
  } catch (e) {
    if ((e as { code?: string }).code === "invalid_grant") {
      await db
        .update(schema.calendarLinks)
        .set({ refreshTokenSealed: null, lastError: "Google access was removed or expired. Connect the calendar again.", updatedAt: new Date() })
        .where(eq(schema.calendarLinks.id, row.id));
      throw new CalendarNotConnected("Google access was removed or expired. Connect the calendar again.");
    }
    throw e;
  }
}

/** Fresh calendar names for the tick list. */
export async function listCalendars(linkId: number): Promise<CalendarEntry[]> {
  const list = await listWith(await accessToken(linkId));
  await db
    .update(schema.calendarLinks)
    .set({ calendarsJson: JSON.stringify(list), updatedAt: new Date() })
    .where(eq(schema.calendarLinks.id, linkId));
  return list;
}

export type RawBusy = { calendarId: string; startAt: number; endAt: number };

/** Google freeBusy can only look so far in one call, so long spans go in pieces. */
const CHUNK_MS = 28 * 24 * 60 * 60 * 1000;

/**
 * Busy times for the ticked calendars between two instants. Recurring events
 * come back expanded, cancelled ones are gone, and events marked Free are left
 * out by Google itself. Any calendar Google can't read makes the whole answer
 * fail, so nobody is ever shown as free on a calendar that wasn't checked.
 */
export async function freeBusy(linkId: number, calendarIds: string[], fromMs: number, toMs: number): Promise<RawBusy[]> {
  if (!calendarIds.length) throw new Error("No calendars are ticked to count as busy.");
  const token = await accessToken(linkId);
  const out: RawBusy[] = [];
  for (let a = fromMs; a < toMs; a += CHUNK_MS) {
    const b = Math.min(toMs, a + CHUNK_MS);
    const res = (await calFetch(token, "freeBusy", {
      method: "POST",
      body: JSON.stringify({
        timeMin: new Date(a).toISOString(),
        timeMax: new Date(b).toISOString(),
        timeZone: "Australia/Brisbane",
        calendarExpansionMax: 50,
        items: calendarIds.slice(0, 50).map((id) => ({ id })),
      }),
    })) as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason?: string }> }> };
    for (const id of calendarIds) {
      const c = res.calendars?.[id];
      if (!c) throw new Error("Google did not answer for one of the ticked calendars.");
      if (c.errors?.length) {
        const why = c.errors.map((e) => e.reason ?? "error").join(", ");
        throw new Error(`Google could not read one of the ticked calendars (${why}).`);
      }
      for (const x of c.busy ?? []) {
        const s = Date.parse(x.start);
        const e = Date.parse(x.end);
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push({ calendarId: id, startAt: s, endAt: e });
      }
    }
  }
  return out;
}

export function safeIds(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function safeCalendars(raw: string | null | undefined): CalendarEntry[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === "string") : [];
  } catch {
    return [];
  }
}
