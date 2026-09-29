import Constants from "expo-constants";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "@template/web";
import { authClient } from "./auth";

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
    const token = authClient.managedAuth.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
  // On a device the bearer token above is the whole story. On web — the Expo
  // preview in a browser — there is no managed token after an email sign-in,
  // only a session cookie, and fetch withholds cookies cross-origin unless
  // told otherwise. Without this the field app renders but every call 401s.
  fetch: (url, init) => fetch(url, { ...init, credentials: "include" }),
});

/** Direct typed client: await client.field.today() */
export const client: AppRouterClient = createORPCClient(link);

/** TanStack Query helpers: useQuery(orpc.field.today.queryOptions()) */
export const orpc = createTanstackQueryUtils(client);
