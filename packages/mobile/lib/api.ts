import Constants from "expo-constants";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "@template/web";
import { authClient } from "./auth";

// Store builds pin the live domain through EXPO_PUBLIC_API_URL (set in eas.json).
// Dev and preview builds fall back to the platform-managed apiUrl.
const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? Constants.expoConfig?.extra?.apiUrl;

const link = new RPCLink({
  url: `${baseUrl}/api/rpc`,
  headers: () => {
    const token = authClient.managedAuth.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
});

/** Direct typed client: await client.field.today() */
export const client: AppRouterClient = createORPCClient(link);

/** TanStack Query helpers: useQuery(orpc.field.today.queryOptions()) */
export const orpc = createTanstackQueryUtils(client);
