import { sql } from "drizzle-orm";
import { base } from "../__core/app";
import { auth } from "../auth";
import { db } from "../database";
import * as schema from "../database/schema";

export const ping = base.handler(() => ({ message: `Pong! ${Date.now()}` }));

/**
 * Deploy check. Reports whether the running server can reach the database and,
 * if it cannot, why. Reports only whether each setting is present, never its
 * value. Safe to leave in place: it exposes no data and no credentials.
 */
export const diag = base.handler(async () => {
  // Bumped whenever this check changes, so the live answer says which build is
  // actually running rather than leaving us to guess whether a publish landed.
  const diagVersion = 3;

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

  // Each step a real request takes, tried on its own so the first failure is
  // named instead of collapsing into a bare 500.
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
  };

  const steps = {
    selectProfiles: await step(() => db.select().from(schema.profiles).limit(1)),
    selectUsers: await step(() => db.run(sql`select count(*) from "user"`)),
    selectSessions: await step(() => db.run(sql`select count(*) from "session"`)),
    writeProbe: await step(() => db.run(sql`create temporary table __probe (x integer)`)),
    getSession: await step(() => auth.api.getSession({ headers: new Headers() })),
  };

  return { diagVersion, env, databaseHost, database, steps };
});
