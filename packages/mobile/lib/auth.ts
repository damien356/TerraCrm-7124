import { createAuthClient } from "better-auth/react";
import { managedAuthExpoClient } from "@runablehq/managed-auth/native";
import { expoClient } from "@better-auth/expo/client";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { clearSavedLogin, safeGet, safeSet } from "./crash-guard";

// Platform-managed identity: never edit `expo.extra` or `expo.scheme` in app.json.
const extra = (Constants.expoConfig?.extra ?? {}) as {
  apiUrl?: string;
  applicationId?: string;
  runableAuthIssuer?: string;
};

// A native sign-in gets its session back as a Set-Cookie and expoClient below
// tucks it into SecureStore. The Expo web preview has no cookie jar of its own
// for that: it serves the app and the API off two different sandbox
// subdomains, and a browser refuses a cross-site cookie either way. Better
// Auth's own answer to that is the bearer plugin (enabled server-side): sign-in
// also comes back with a "set-auth-token" header, and replaying that as
// "Authorization: Bearer <token>" on every later request works from any
// origin. These two helpers are that token's only home on web.
const WEB_TOKEN_KEY = "terra-ops.session-token";

export function getWebSessionToken(): string | null {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return null;
  return localStorage.getItem(WEB_TOKEN_KEY);
}

function setWebSessionToken(token: string | null) {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  if (token) localStorage.setItem(WEB_TOKEN_KEY, token);
  else localStorage.removeItem(WEB_TOKEN_KEY);
}

/** Runable managed sign-in token, kept where the plugin keeps it, never throwing. */
const MANAGED_TOKEN_KEY = "runable.managed-auth.token";
let managedToken: string | undefined;
const safeTokenStore = {
  getToken: () => (managedToken ??= safeGet(MANAGED_TOKEN_KEY) ?? ""),
  setToken: (token: string) => {
    managedToken = token;
    safeSet(MANAGED_TOKEN_KEY, token);
  },
  clearToken: () => {
    managedToken = "";
    safeSet(MANAGED_TOKEN_KEY, "");
  },
};

/**
 * The saved sign-in cookie, with its end date taken off (notes 18.63).
 *
 * @better-auth/expo stops sending a cookie once the date it came with has
 * passed. That date is only ever renewed when a sign-in call answers, but the
 * server slides the login forward on every ordinary request too, so the phone's
 * copy of the date fell behind and the phone gave up on a login the server
 * still honoured. Now the phone always sends it and the server alone decides.
 * A sign-out still clears it, and a cookie the server cancels is still dropped.
 */
const COOKIE_KEY = "better-auth_cookie";

export function serverJudges(raw: string | null): string | null {
  if (!raw || raw[0] !== "{") return raw;
  try {
    const jar = JSON.parse(raw) as Record<string, { value?: string; expires?: string | null }>;
    if (!jar || typeof jar !== "object") return raw;
    let changed = false;
    for (const c of Object.values(jar)) {
      if (c && typeof c === "object" && c.expires != null) {
        c.expires = null;
        changed = true;
      }
    }
    return changed ? JSON.stringify(jar) : raw;
  } catch {
    return raw;
  }
}

/**
 * Wipe the login off this phone without asking the server. For the recovery
 * screen and a session the server no longer knows. The next session check
 * comes back signed out.
 */
export function forgetLoginOnPhone() {
  clearSavedLogin();
  setWebSessionToken(null);
  managedToken = "";
}

export const authClient = createAuthClient({
  baseURL: process.env.EXPO_PUBLIC_API_URL ?? extra.apiUrl,
  basePath: "/api/auth",
  fetchOptions: {
    // Sends the stored token back on every request this client makes
    // (get-session, sign-out, ...). A missing token just sends no header.
    auth: Platform.OS === "web" ? { type: "Bearer", token: () => getWebSessionToken() ?? "" } : undefined,
    onSuccess(context) {
      if (Platform.OS !== "web") return;
      const url = context.request.url.toString();
      const issuedToken = context.response.headers.get("set-auth-token");
      if (issuedToken) setWebSessionToken(issuedToken);
      if (url.includes("/sign-out")) setWebSessionToken(null);
    },
  },
  plugins: [
    managedAuthExpoClient({
      applicationId: extra.applicationId as string,
      issuer: extra.runableAuthIssuer as string,
      // Same keychain slot the plugin uses by default, read through the startup
      // guard so a value the phone cannot read signs out instead of crashing.
      storage: Platform.OS === "web" ? undefined : safeTokenStore,
    }),
    // Native only: an email sign-in comes back as a Set-Cookie, and this keeps
    // it in the keychain instead, handing it back through authClient.getCookie().
    expoClient({
      scheme: Constants.expoConfig?.scheme as string,
      // Read through the startup guard (lib/crash-guard.ts). This used to call
      // SecureStore straight, at load, so one unreadable value closed the app
      // on every launch until it was reinstalled.
      storage: {
        getItem: (key) => (key === COOKIE_KEY ? serverJudges(safeGet(key)) : safeGet(key)),
        setItem: (key, value) => safeSet(key, key === COOKIE_KEY ? (serverJudges(value) ?? value) : value),
      },
    }),
  ],
});

/**
 * The session for the office pages the app shows from the website (notes
 * 18.44). They sign in the same way the website does, with a bearer token
 * kept in the page's storage, so the app hands them the one it already has.
 * A Runable sign-in has a token of its own. An email sign-in has a session
 * cookie, and its signed value works as the same bearer token.
 */
export function sessionTokenForWebPages(): string | null {
  const managed = authClient.managedAuth.getToken();
  if (managed) return managed;
  if (Platform.OS === "web") return getWebSessionToken();
  const cookie = authClient.getCookie?.() ?? "";
  const match = /(?:^|;\s*)(?:__Secure-)?[A-Za-z0-9_.-]*session_token=([^;]+)/.exec(cookie);
  return match?.[1] ?? null;
}
