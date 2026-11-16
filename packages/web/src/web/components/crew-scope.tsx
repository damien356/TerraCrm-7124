import { Users } from "lucide-react";
import { jobText, taskRef } from "../../api/lib/refs";
import { useJob } from "../queries/jobs";
import { Select } from "./ui/field";

/*
 * Which crew a material or a file is for, on a job with more than one crew
 * (Damien, 15 Nov 2026, job 188070). The server decides what each installer
 * gets (lib/task-scope.ts). This only lets the office pick, and says plainly
 * that a row nobody picked stays off every crew's phone.
 */

export type ScopeOption = { id: number; label: string; full: string };

/** The job's work dispatches, in words, and whether the job has more than one crew. */
export function useCrewScope(jobId: number) {
  const job = useJob(jobId);
  const j = job.data;
  const multiCrew = Boolean(j?.crewScope.multiCrew);
  const options: ScopeOption[] = j
    ? j.tasks
        .filter((t) => j.crewScope.dispatches.includes(t.id))
        .map((t) => {
          // Short in the picker so the product name keeps its room; the full line is the hover text. Damien, 16 Nov 2026.
          const who = t.installer?.name ?? "Not assigned yet";
          const ref = taskRef(jobText(j), t.seq);
          return { id: t.id, label: `${ref} · ${who}`, full: `${ref} ${t.title} · ${who}` };
        })
    : [];
  return { multiCrew, options, needs: j?.crewScope.needsDispatch ?? { materials: [], media: [] } };
}

const NONE = "";
const SHARED = "shared";

export function scopeValue(row: { taskId: number | null; crewShared: boolean | null }, options: ScopeOption[]) {
  if (row.crewShared) return SHARED;
  if (row.taskId != null && options.some((o) => o.id === row.taskId)) return `task:${row.taskId}`;
  return NONE;
}

/** Shared keeps whatever dispatch it had (taskId left out), so the record still says whose it was. */
export function parseScope(v: string): { taskId?: number | null; crewShared: boolean } {
  if (v === SHARED) return { crewShared: true };
  if (v.startsWith("task:")) return { taskId: Number(v.slice(5)), crewShared: false };
  return { taskId: null, crewShared: false };
}

export function CrewScopeSelect({
  value,
  options,
  onChange,
  className = "",
  label = "Which crew gets this",
}: {
  value: string;
  options: ScopeOption[];
  onChange: (v: string) => void;
  className?: string;
  label?: string;
}) {
  return (
    <Select
      aria-label={label}
      className={`h-8 w-auto max-w-full text-xs ${value === NONE ? "border-[#C77A12] text-[#8A520A]" : ""} ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value={NONE}>Needs a dispatch (crew can't see it)</option>
      {options.map((o) => (
        <option key={o.id} value={`task:${o.id}`} title={o.full}>
          {o.label}
        </option>
      ))}
      <option value={SHARED}>Every crew on this job</option>
    </Select>
  );
}

/** "3 materials need a dispatch." Shown only on a job with more than one crew. */
export function NeedsDispatchBanner({ count, what }: { count: number; what: string }) {
  if (!count) return null;
  return (
    <div className="flex items-start gap-2 border-b border-border bg-[#C77A12]/10 px-4 py-2.5 text-xs text-[#6E4208]" data-testid="needs-dispatch">
      <Users className="mt-0.5 size-4 shrink-0" />
      <span>
        <span className="font-semibold">
          {count} {what}
          {count === 1 ? " needs" : " need"} a dispatch.
        </span>{" "}
        More than one crew is on this job, so each crew only sees what is picked for their dispatch. Until you pick one, no crew sees {count === 1 ? "it" : "them"}.
      </span>
    </div>
  );
}
