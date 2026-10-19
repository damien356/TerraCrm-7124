import { and, eq, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { checkInstallerAbn } from "./abn-check";
import { isLiveServer } from "./runtime";

/* ---------------------------------------------------------------------------
 * The monthly ABN recheck (notes 18.64). Every current installer with an ABN
 * is looked up again once his last check is 30 days old. A card never
 * checked is looked up on the first pass, so publishing fills the cards.
 * A failed call is tried again the next day. When he's cancelled, or GST
 * starts or stops, his card is updated and an Admin only task goes on the
 * 7am list.
 *
 * Runs on the published server only, the same gate as the 7am summary.
 * ABN_RECHECK=off stops it, ABN_RECHECK=on runs it anywhere (tests).
 * ------------------------------------------------------------------------- */

const MONTH_MS = 30 * 86_400_000;
const RETRY_MS = 20 * 3_600_000;
const PER_PASS = 20;

/** Who is due now. Exported for tests. */
export async function dueForRecheck(now = new Date()) {
  const monthAgo = new Date(now.getTime() - MONTH_MS);
  const retryAgo = new Date(now.getTime() - RETRY_MS);
  return db
    .select({ id: schema.installers.id })
    .from(schema.installers)
    .where(
      and(
        eq(schema.installers.active, true),
        isNull(schema.installers.archivedAt),
        isNotNull(schema.installers.abn),
        ne(schema.installers.abn, ""),
        or(
          isNull(schema.installers.abnCheckedAt),
          lt(schema.installers.abnCheckedAt, monthAgo),
          and(isNotNull(schema.installers.abnCheckError), lt(schema.installers.abnCheckedAt, retryAgo)),
        ),
      ),
    )
    .limit(PER_PASS);
}

let running = false;

/** One pass. Exported for tests. */
export async function tickAbnRecheck(now = new Date()) {
  if (running) return { checked: 0, tasks: 0 };
  running = true;
  let checked = 0;
  let tasks = 0;
  try {
    for (const { id } of await dueForRecheck(now)) {
      const out = await checkInstallerAbn(id, { monthly: true, now });
      checked += 1;
      if (out?.taskId) tasks += 1;
    }
    if (checked) console.log(`[abn] rechecked ${checked} installer ABN${checked === 1 ? "" : "s"}, ${tasks} task${tasks === 1 ? "" : "s"} raised`);
  } catch (e) {
    console.error("[abn] recheck failed:", (e as Error).message ?? e);
  } finally {
    running = false;
  }
  return { checked, tasks };
}

let booted = false;

export function bootAbnRecheck() {
  if (booted) return;
  booted = true;
  const mode = process.env.ABN_RECHECK;
  if (mode === "off") {
    console.log("[abn] monthly recheck disabled by ABN_RECHECK=off");
    return;
  }
  if (mode !== "on" && !isLiveServer()) {
    console.log("[abn] monthly recheck idle, not the published server");
    return;
  }
  console.log("[abn] monthly ABN recheck looks every hour");
  setInterval(() => void tickAbnRecheck(), 3_600_000);
  setTimeout(() => void tickAbnRecheck(), 120_000);
}
