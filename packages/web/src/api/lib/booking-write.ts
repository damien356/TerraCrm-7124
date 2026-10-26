/**
 * The booking write, all or nothing (measure booking stage 0).
 *
 * Before: the days were deleted in one call and written in the next, so a
 * failure in between left the task with no days at all. Now the old days go,
 * the new days go in, the activity row, the audit row and the task update all
 * run in one batch. Either all of it lands or none of it does.
 *
 * Stale edits: every statement only runs while the task is still at the
 * version the caller read. The task update bumps the version last. If someone
 * else saved in between, every statement matches nothing, the update reports
 * 0 rows and the caller is told. Batches are serialised, so two saves from the
 * same version can never both land.
 *
 * Takes the libsql client so the tests can run it on their own database.
 */
import type { Client, InStatement } from "@libsql/client";

export interface BookingDay {
  date: string;
  seq: number;
  arrivalStart: string | null;
  arrivalEnd: string | null;
  coordinate: boolean;
  installerId: number | null;
  overrideNote: string | null;
}

export interface BookingTaskPatch {
  assignedInstallerId: number;
  /** Undefined leaves the column alone. */
  secondInstallerId?: number | null;
  status: string;
  scheduledDate: string;
  scheduledFrom: string;
  scheduledTo: string;
  startTime: string | null;
  durationHours?: number;
  payAmount?: number;
  manualDays?: number | null;
}

export interface BookingWrite {
  taskId: number;
  jobId: number;
  /** The version this save was made from. */
  expectedVersion: number;
  days: BookingDay[];
  patch: BookingTaskPatch;
  activity: { action: string; detail: string };
  audit: { action: string; before: unknown; after: unknown; reason: string | null; requestKey: string | null };
  actor: { userId: string; name: string; role: string };
  now?: Date;
  /** Tests only: fail the batch right after the old days are cleared. */
  faultAfterClear?: boolean;
}

export type BookingWriteResult = { ok: true; version: number } | { ok: false; reason: "stale"; version: number | null };

const STILL_AT = "EXISTS (SELECT 1 FROM job_tasks WHERE id = ? AND version = ?)";

export async function writeBooking(client: Client, w: BookingWrite): Promise<BookingWriteResult> {
  const at = Math.floor((w.now ?? new Date()).getTime() / 1000);
  const g = [w.taskId, w.expectedVersion];
  const stmts: InStatement[] = [];

  stmts.push({ sql: `DELETE FROM task_days WHERE task_id = ? AND ${STILL_AT}`, args: [w.taskId, ...g] });
  if (w.faultAfterClear) stmts.push({ sql: "SELECT * FROM forced_failure_after_clear", args: [] });
  for (const d of w.days) {
    stmts.push({
      sql: `INSERT INTO task_days (task_id, date, seq, arrival_start, arrival_end, coordinate, installer_id, status, override_note, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ? WHERE ${STILL_AT}`,
      args: [w.taskId, d.date, d.seq, d.arrivalStart, d.arrivalEnd, d.coordinate ? 1 : 0, d.installerId, d.overrideNote, at, at, ...g],
    });
  }
  stmts.push({
    sql: `INSERT INTO activity_log (job_id, task_id, entity_type, entity_id, action, detail, actor_name, actor_role, created_at)
          SELECT ?, ?, 'task', ?, ?, ?, ?, ?, ? WHERE ${STILL_AT}`,
    args: [w.jobId, w.taskId, w.taskId, w.activity.action, w.activity.detail, w.actor.name, w.actor.role, at, ...g],
  });
  stmts.push({
    sql: `INSERT INTO audit_events (entity_type, entity_id, job_id, task_id, action, before_json, after_json, reason, request_key, actor_user_id, actor_name, actor_role, created_at)
          SELECT 'task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${STILL_AT}`,
    args: [
      w.taskId,
      w.jobId,
      w.taskId,
      w.audit.action,
      JSON.stringify(w.audit.before ?? null),
      JSON.stringify(w.audit.after ?? null),
      w.audit.reason,
      w.audit.requestKey,
      w.actor.userId,
      w.actor.name,
      w.actor.role,
      at,
      ...g,
    ],
  });

  const p = w.patch;
  const sets: string[] = ["assigned_installer_id = ?", "status = ?", "scheduled_date = ?", "scheduled_from = ?", "scheduled_to = ?", "start_time = ?"];
  const args: (string | number | null)[] = [p.assignedInstallerId, p.status, p.scheduledDate, p.scheduledFrom, p.scheduledTo, p.startTime];
  if (p.secondInstallerId !== undefined) {
    sets.push("second_installer_id = ?");
    args.push(p.secondInstallerId);
  }
  if (p.durationHours !== undefined) {
    sets.push("duration_hours = ?");
    args.push(p.durationHours);
  }
  if (p.payAmount !== undefined) {
    sets.push("pay_amount = ?");
    args.push(p.payAmount);
  }
  if (p.manualDays !== undefined) {
    sets.push("manual_days = ?");
    args.push(p.manualDays);
  }
  sets.push("updated_at = ?", "version = version + 1");
  args.push(at);
  stmts.push({ sql: `UPDATE job_tasks SET ${sets.join(", ")} WHERE id = ? AND version = ?`, args: [...args, ...g] });

  const results = await client.batch(stmts, "write");
  if (results[results.length - 1]!.rowsAffected === 1) return { ok: true, version: w.expectedVersion + 1 };
  const now = (await client.execute({ sql: "SELECT version FROM job_tasks WHERE id = ?", args: [w.taskId] })).rows[0];
  return { ok: false, reason: "stale", version: now ? Number(now.version) : null };
}
