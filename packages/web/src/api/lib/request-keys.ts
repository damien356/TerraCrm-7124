/**
 * Duplicate protection for writes (measure booking stage 0).
 *
 * The screen sends a key with an action. The first call with that key does the
 * work and its answer is kept. A repeat of the same key, from a double tap or a
 * retry after a dropped connection, waits for the first one and gets the same
 * answer back. It never does the work a second time.
 *
 * - No key: the work just runs, exactly as before.
 * - The first call fails: its key is released, so a retry can run it again.
 * - A key reused for a different action is refused.
 * - A key left pending by a server that died mid-request is taken over after
 *   STALE_MS, so a crash never blocks a retry for good.
 *
 * Takes the libsql client so the tests can run it on their own database.
 */
import type { Client } from "@libsql/client";

export const STALE_MS = 2 * 60 * 1000;
const WAIT_MS = 15_000;
const POLL_MS = 60;
const KEEP_DAYS = 7;

export class RequestKeyError extends Error {
  constructor(
    public code: "KEY_REUSED" | "STILL_RUNNING",
    message: string,
  ) {
    super(message);
  }
}

const sec = (ms: number) => Math.floor(ms / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface KeyOpts {
  key: string | null | undefined;
  actorUserId: string;
  action: string;
  /** Test hooks. */
  now?: () => number;
  waitMs?: number;
}

/**
 * Run `work` once per key. `work` returns the answer for this caller and a
 * small JSON-safe record kept for repeats. `replay` turns that record back into
 * an answer for a repeat call.
 */
export async function runOnce<T>(
  client: Client,
  opts: KeyOpts,
  work: () => Promise<{ result: T; stored: unknown }>,
  replay: (stored: any) => Promise<T>,
): Promise<T> {
  if (!opts.key) return (await work()).result;
  const now = opts.now ?? Date.now;
  const waitMs = opts.waitMs ?? WAIT_MS;
  const started = now();
  const id = [opts.actorUserId, opts.key];

  for (;;) {
    const claim = await client.execute({
      sql: "INSERT INTO request_keys (actor_user_id, key, action, status, created_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING",
      args: [...id, opts.action, sec(now())],
    });
    if (claim.rowsAffected === 1) return own();

    const row = (
      await client.execute({ sql: "SELECT action, status, response_json, created_at FROM request_keys WHERE actor_user_id = ? AND key = ?", args: id })
    ).rows[0] as unknown as { action: string; status: string; response_json: string | null; created_at: number } | undefined;
    if (!row) continue; // The first try failed and let go of the key. Claim it.
    if (row.action !== opts.action) throw new RequestKeyError("KEY_REUSED", "This request key was already used for something else.");
    if (row.status === "done") return replay(row.response_json ? JSON.parse(row.response_json) : null);

    // Pending. A dead server's claim is taken over, otherwise wait for the first try.
    if (now() - Number(row.created_at) * 1000 > STALE_MS) {
      const took = await client.execute({
        sql: "UPDATE request_keys SET created_at = ? WHERE actor_user_id = ? AND key = ? AND status = 'pending' AND created_at = ?",
        args: [sec(now()), ...id, row.created_at],
      });
      if (took.rowsAffected === 1) return own();
      continue;
    }
    if (now() - started > waitMs) throw new RequestKeyError("STILL_RUNNING", "The first try is still saving. Refresh in a moment to see it.");
    await sleep(POLL_MS);
  }

  async function own(): Promise<T> {
    let out: { result: T; stored: unknown };
    try {
      out = await work();
    } catch (e) {
      await client.execute({ sql: "DELETE FROM request_keys WHERE actor_user_id = ? AND key = ? AND status = 'pending'", args: id }).catch(() => {});
      throw e;
    }
    await client.execute({
      sql: "UPDATE request_keys SET status = 'done', response_json = ?, completed_at = ? WHERE actor_user_id = ? AND key = ?",
      args: [JSON.stringify(out.stored ?? null), sec(now()), ...id],
    });
    // Old keys are only for retries. Tidy now and then.
    if (Math.random() < 0.02) {
      await client
        .execute({ sql: "DELETE FROM request_keys WHERE status = 'done' AND created_at < ?", args: [sec(now() - KEEP_DAYS * 86400_000)] })
        .catch(() => {});
    }
    return out.result;
  }
}
