import { AsyncLocalStorage } from "node:async_hooks";
import type { Client } from "@libsql/client";
import { db } from "./__client";

/**
 * Which database a request talks to.
 *
 * Almost always the live one. The exception is the Google Play reviewer login,
 * whose requests run inside `runOnDemo` and so read and write a separate demo
 * database instead (see ./demo.ts). The switch is per request, carried by
 * AsyncLocalStorage, so nothing the reviewer does can reach a live row and
 * nothing a real user does can land in the demo.
 *
 * The switch sits at the lowest point there is: the live connection itself.
 * Every query Drizzle builds, from any file, ends in one of the four calls
 * below on `db.$client`. Each one checks the request's scope and sends the
 * statement to the demo connection when it is set. So there is no import to
 * get wrong: code written next year that forgets the demo exists still cannot
 * show the reviewer a live row.
 */

export type TerraDb = typeof db;

/** A demo database: its own Drizzle instance and the connection under it. */
export type DemoDb = { db: TerraDb; client: Client };

const scope = new AsyncLocalStorage<DemoDb>();

/** True while handling a Play reviewer request. */
export const inDemo = () => scope.getStore() !== undefined;

/** Run `fn`, and everything it awaits or schedules, against the demo database. */
export function runOnDemo<T>(target: DemoDb, fn: () => T): T {
  return scope.run(target, fn);
}

/**
 * Run `fn` on live even if called from inside a demo request. Only for the
 * demo builder, which copies the table layout and two reference lists.
 */
export function onLive<T>(fn: () => T): T {
  return scope.exit(fn);
}

type Routed = "execute" | "batch" | "transaction" | "migrate";
const ROUTED: Routed[] = ["execute", "batch", "transaction", "migrate"];

const live = db.$client as Client;
const PATCHED = Symbol.for("terra.demo-routed");

if (!(live as any)[PATCHED]) {
  for (const name of ROUTED) {
    const original = (live as any)[name];
    if (typeof original !== "function") continue;
    const own = original.bind(live);
    (live as any)[name] = (...args: unknown[]) => {
      const demo = scope.getStore();
      return demo ? (demo.client as any)[name](...args) : own(...args);
    };
  }
  (live as any)[PATCHED] = true;
}
