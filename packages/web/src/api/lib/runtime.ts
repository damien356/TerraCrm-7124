/* ---------------------------------------------------------------------------
 * Is this process the live server?
 *
 * Timers that send things (mailbox checks, reminder pushes) must run in one
 * place only: the published server. The same API code is also loaded by the
 * Vite dev server and by scratch scripts in the sandbox, which point at the
 * live database. A timer there would send real mail and pushes from a
 * developer's sandbox, and stamp them done so live never sends them.
 *
 * The old check looked for the entry script `__server.ts`. Live is launched
 * from a bundled `server.ts`, so it never passed and nothing ever ran on live.
 *
 * Live means: NODE_ENV is production, not inside the sandbox, not under Vite
 * and not under a test runner.
 * ------------------------------------------------------------------------- */

export function isLiveServer(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  if (process.env.E2B_SANDBOX || process.env.E2B_SANDBOX_ID) return false;
  if (process.env.VITEST || process.env.BUN_TEST) return false;
  const argv = (process as unknown as { argv?: string[] }).argv ?? [];
  if (argv.some((a) => /(^|[\\/])vite(\.js)?$|[\\/]vite[\\/]bin[\\/]/.test(a))) return false;
  if (argv[1] === "test") return false;
  return true;
}
