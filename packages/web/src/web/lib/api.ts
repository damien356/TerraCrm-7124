import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "../../api";
import { authClient } from "./auth";
import { isPhoneApp, PHONE_APP_HEADER, PHONE_APP_VALUE } from "./phone-app";

const link = new RPCLink({
  url: `${window.location.origin}/api/rpc`,
  headers: () => {
    const token = authClient.managedAuth.getToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    // Inside the phone app the server holds the same lines as the screen (notes 18.44).
    if (isPhoneApp) headers[PHONE_APP_HEADER] = PHONE_APP_VALUE;
    return headers;
  },
});

/** Direct typed client: await client.dashboard.summary() */
export const client: AppRouterClient = createORPCClient(link);

/** TanStack Query helpers — wrap them in src/web/queries/, never inline. */
export const orpc = createTanstackQueryUtils(client);
