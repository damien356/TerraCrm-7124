import { sql } from "drizzle-orm";
import { base } from "../__core/app";
import { db } from "../database";

export const ping = base.handler(() => ({ message: `Pong! ${Date.now()}` }));

/**
 * Deploy check. Reports whether the running server can reach the database and,
 * if it cannot, why. Reports only whether each setting is present, never its
 * value. Safe to leave in place: it exposes no data and no credentials.
 */
export const diag = base.handler(async () => {
  const env = {
    databaseUrl: Boolean(process.env.DATABASE_URL),
    databaseAuthToken: Boolean(process.env.DATABASE_AUTH_TOKEN),
    betterAuthSecret: Boolean(process.env.BETTER_AUTH_SECRET),
    websiteUrl: process.env.WEBSITE_URL ?? null,
    applicationId: Boolean(process.env.APPLICATION_ID),
    authIssuer: Boolean(process.env.VITE_RUNABLE_AUTH_ISSUER),
    nodeEnv: process.env.NODE_ENV ?? null,
  };

  // Which host the database points at, without the token or the full path.
  let databaseHost: string | null = null;
  try {
    databaseHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : null;
  } catch {
    databaseHost = "unparseable";
  }

  let database: { ok: boolean; error?: string } = { ok: false };
  try {
    await db.run(sql`select 1`);
    database = { ok: true };
  } catch (error) {
    database = {
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }

  return { env, databaseHost, database };
});
