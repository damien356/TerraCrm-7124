import Constants from "expo-constants";
import { Platform } from "react-native";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "@template/web";
import { authClient, getWebSessionToken } from "./auth";
import { readCrewKey } from "./crew-key";

// Store builds pin the live domain through EXPO_PUBLIC_API_URL (set in eas.json).
// Dev and preview builds fall back to the platform-managed apiUrl.
// The platform-managed apiUrl carries a trailing slash, which would make every
// request path "//api/rpc/…". Harmless today, but it breaks any origin check
// that compares paths, so normalise it once here.
const rawBaseUrl = process.env.EXPO_PUBLIC_API_URL ?? Constants.expoConfig?.extra?.apiUrl;
const baseUrl = String(rawBaseUrl ?? "").replace(/\/+$/, "");

/** The Terra Ops site this build talks to, for links that open the full web app. */
export const siteUrl = baseUrl;

/**
 * The signed-in session, as request headers.
 *
 * Two ways in. A Runable managed sign-in carries a bearer token. An email and
 * password sign-in carries a session cookie, which on a phone lives in the
 * keychain and has to be put on the request by hand. Send whichever one this
 * login actually has.
 */
function sessionHeaders(): Record<string, string> {
  const token = authClient.managedAuth.getToken();
  if (token) return { Authorization: `Bearer ${token}` };
  // A browser drops a cross-origin session cookie regardless of what we set
  // by hand, so the web preview keeps its token in storage instead and
  // replays it as a bearer header (see lib/auth.ts). A phone keeps the
  // cookie itself and puts it on the request the same way.
  if (Platform.OS === "web") {
    const webToken = getWebSessionToken();
    return webToken ? { Authorization: `Bearer ${webToken}` } : {};
  }
  const cookie = authClient.getCookie?.();
  return cookie ? { Cookie: cookie } : {};
}

// In a browser the cookie is the browser's to send, and fetch withholds it on
// a cross-origin call unless asked. Without this the field app renders on the
// web preview but every call 401s.
const withCredentials = (url: Request | string | URL, init?: RequestInit) => fetch(url, { ...init, credentials: "include" });

const link = new RPCLink({
  url: `${baseUrl}/api/rpc`,
  headers: () => sessionHeaders(),
  fetch: withCredentials,
});

/** Direct typed client: await client.field.today() */
export const client: AppRouterClient = createORPCClient(link);

/** TanStack Query helpers: useQuery(orpc.field.today.queryOptions()) */
export const orpc = createTanstackQueryUtils(client);

/**
 * For calls that may run with the phone locked: geofence arrivals and leaves.
 * Sends this phone's crew key when it has one (readable while locked, see
 * lib/crew-key.ts), else the normal session. Only voice.* and visits.* accept
 * the key, so only use this client for those.
 */
const crewLink = new RPCLink({
  url: `${baseUrl}/api/rpc`,
  headers: async () => {
    const key = await readCrewKey();
    return key ? { "x-terra-voice-key": key } : sessionHeaders();
  },
  fetch: withCredentials,
});

export const crewClient: AppRouterClient = createORPCClient(crewLink);
