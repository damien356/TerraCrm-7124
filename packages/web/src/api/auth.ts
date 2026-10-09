import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { expo } from "@better-auth/expo";
import { runableManagedAuth } from "@runablehq/managed-auth/server";
import { db } from "./database";
import { isLiveServer } from "./lib/runtime";

const LIVE_ORIGINS = [
  process.env.WEBSITE_URL,
  "https://ops.terraflooring.com.au",
  "https://terraop-l8jfdfu.runable.site",
  // The phone app sends its scheme as the origin (see @better-auth/expo).
  "runable-terraop-l8jfdfu://",
]
  .filter((o): o is string => !!o)
  .map((o) => (o.startsWith("http") ? o.replace(/\/+$/, "") : o));

export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL: process.env.WEBSITE_URL,
  database: drizzleAdapter(db, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET,
  // Only our own sites and the phone app may sign in with a cookie. The old
  // rule echoed back whatever origin asked, which let any site in. Sandbox and
  // preview servers still trust the asking origin, because their hostnames
  // change from one session to the next.
  trustedOrigins: (request) => {
    const list = [...LIVE_ORIGINS];
    if (!isLiveServer()) {
      list.push("exp://");
      const origin = request?.headers.get("origin");
      if (origin) list.push(origin);
    }
    return list;
  },
  plugins: [
    ...runableManagedAuth({
      applicationId: process.env.APPLICATION_ID!,
      issuer: process.env.VITE_RUNABLE_AUTH_ISSUER!,
    }),
    expo(),
    // The mobile web preview serves the app and the API off two different
    // sandbox subdomains, and a browser drops that cross-origin session
    // cookie regardless. This hands sign-in a "set-auth-token" header too
    // (already exposed by CORS in __core/app.ts), so the client can replay
    // it as "Authorization: Bearer <token>" instead.
    bearer(),
  ],
});
