import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { expo } from "@better-auth/expo";
import { runableManagedAuth } from "@runablehq/managed-auth/server";
import { APIError } from "better-auth/api";
import { db } from "./database";
import * as schema from "./database/schema";
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

export const NO_LOGIN = "There is no Terra Ops login for this account. Ask the office to add you.";

export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL: process.env.WEBSITE_URL,
  database: drizzleAdapter(db, { provider: "sqlite" }),
  // No public sign-up. Logins are made by an Admin in Admin, People (see
  // routes/team.ts, which writes the rows itself). Sign in still works.
  emailAndPassword: { enabled: true, disableSignUp: true },
  databaseHooks: {
    user: {
      create: {
        // Google sign-in would otherwise make a brand new login for any Google
        // account. Only an empty database (first ever setup) may do that.
        before: async () => {
          const any = await db.select({ id: schema.profiles.id }).from(schema.profiles).limit(1);
          if (any.length > 0) {
            throw new APIError("FORBIDDEN", { message: NO_LOGIN });
          }
        },
      },
    },
  },
  secret: process.env.BETTER_AUTH_SECRET,
  // A login lasts 90 days from the last time it was used, and every day it is
  // used pushes that on again. So a crew phone stays signed in for as long as
  // the installer keeps opening Terra, and only the office switching the login
  // off (Admin, People, which also ends its sessions) signs it out (notes 18.63).
  session: {
    expiresIn: 60 * 60 * 24 * 90,
    updateAge: 60 * 60 * 24,
  },
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
