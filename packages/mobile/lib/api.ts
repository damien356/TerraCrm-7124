import Constants from "expo-constants";
import { Platform } from "react-native";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "@template/web";
import { authClient, getWebSessionToken } from "./auth";

// Store builds pin the live domain through EXPO_PUBLIC_API_URL (set in eas.json).
// Dev and preview builds fall back to the platform-managed apiUrl.
// The platform-managed apiUrl carries a trailing slash, which would make every
// request path "//api/rpc/…". Harmless today, but it breaks any origin check
// that compares paths, so normalise it once here.
const rawBaseUrl = process.env.EXPO_PUBLIC_API_URL ?? Constants.expoConfig?.extra?.apiUrl;
const baseUrl = String(rawBaseUrl ?? "").replace(/\/+$/, "");

const link = new RPCLink({
  url: `${baseUrl}/api/rpc`,
  headers: () => {
    // Two ways in. A Runable managed sign-in carries a bearer token. An email
    // and password sign-in carries a session cookie, which on a phone lives in
    // the keychain and has to be put on the request by hand. Send whichever
    // one this login actually has.
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
  },
  // In a browser the cookie is the browser's to send, and fetch withholds it on
  // a cross-origin call unless asked. Without this the field app renders on the
  // web preview but every call 401s.
  fetch: (url, init) => fetch(url, { ...init, credentials: "include" }),
});

/** Direct typed client: await client.field.today() */
export const client: AppRouterClient = createORPCClient(link);

/** TanStack Query helpers: useQuery(orpc.field.today.queryOptions()) */
export const orpc = createTanstackQueryUtils(client);
