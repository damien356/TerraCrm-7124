import { client } from "./api";
import { appInfo, clearProblems, pendingProblems } from "./crash-guard";

/**
 * Send the problems this phone has kept (lib/crash-guard.ts) to Ops. Runs once
 * the app is up and again when it comes back to the front. Works signed out
 * too, which is when a login problem is most likely. Never throws: a report
 * that cannot go yet waits on the phone for next time.
 */
let sending = false;

export async function sendProblems() {
  if (sending) return;
  const list = pendingProblems().slice(0, 10);
  if (!list.length) return;
  sending = true;
  try {
    await client.devices.reportProblem({ app: appInfo(), problems: list });
    clearProblems(list.length);
  } catch {
    /* Still on the phone. Next time. */
  } finally {
    sending = false;
  }
}
