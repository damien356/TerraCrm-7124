import { AlertTriangle, CheckCircle2, Users } from "lucide-react";
import { jobText, taskRef } from "../../api/lib/refs";
import { useCrewView, useJob } from "../queries/jobs";
import { Card, CardHeader } from "./ui/card";
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
      className={`h-8 w-auto max-w-full text-xs sm:max-w-[15rem] ${value === NONE ? "border-[#C77A12] text-[#8A520A]" : ""} ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {/* Plain words, Damien 16 Nov 2026: "so a dummy can work it out". */}
      <option value={NONE}>Nobody sees this yet. Pick a crew</option>
      {options.map((o) => (
        <option key={o.id} value={`task:${o.id}`} title={o.full}>
          {o.label}
        </option>
      ))}
      <option value={SHARED}>Everyone on this job</option>
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
          {count === 1 ? " has" : " have"} no crew picked, so nobody sees {count === 1 ? "it" : "them"}.
        </span>{" "}
        Pick a crew in the box next to {count === 1 ? "it" : "each one"}, or Everyone on this job.
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Which crew sees what (Damien, 16 Nov 2026): "make it easy to show whom sees
 * what, so a dummy can work it out". One box per person on the work, and one
 * per dispatch nobody is on yet, listing exactly what their phone shows. The
 * server runs the same rules as the phone (jobs.crewView).
 * ------------------------------------------------------------------------- */

const BUCKET_WORDS: Record<string, string> = {
  plan: "Plans",
  access: "Site access",
  area: "Areas we're doing",
  damage: "Existing damage",
  found: "What we found",
  completion: "Completion",
  defect: "Defects & callbacks",
  client_reported: "Client photos",
};

function fileWords(files: { bucket: string }[]) {
  if (!files.length) return "None";
  const by = new Map<string, number>();
  for (const f of files) by.set(f.bucket, (by.get(f.bucket) ?? 0) + 1);
  return [...by.entries()].map(([b, n]) => `${n} in ${BUCKET_WORDS[b] ?? b}`).join(", ");
}

export function CrewViewCard({ jobId }: { jobId: number }) {
  const job = useJob(jobId);
  const j = job.data;
  const multi = Boolean(j?.crewScope.multiCrew);
  const view = useCrewView(jobId, multi);
  if (!j || !multi || !view.data) return null;
  const v = view.data;
  const mat = new Map(j.materials.map((m) => [m.id, m]));
  const task = new Map(j.tasks.map((t) => [t.id, t]));
  const ref = (id: number) => {
    const t = task.get(id);
    return t ? `${taskRef(jobText(j), t.seq)} ${t.title}` : `Dispatch ${id}`;
  };
  const waiting = v.nobody.materials.length + v.nobody.files.length;

  return (
    <Card data-testid="crew-view">
      <CardHeader
        title="Which crew sees what"
        subtitle="More than one crew is on this job. Each box is exactly what that crew sees on their phone. Change it with the box next to each material or file."
      />
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        {v.crews.map((c, i) => (
          <div key={c.installerId ?? `open-${c.taskIds.join("-")}-${i}`} className="rounded-lg border border-border p-3" data-testid="crew-view-box">
            <p className="text-sm font-semibold">{c.name ?? "Nobody on it yet"}</p>
            {c.taskIds.map((id) => (
              <p key={id} className="text-xs break-words text-muted-foreground">
                {ref(id)}
              </p>
            ))}
            {c.installerId == null ? <p className="mt-1 text-xs text-muted-foreground">Whoever you put on it sees this.</p> : null}
            <p className="mt-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Materials</p>
            {c.materials.length ? (
              <ul className="mt-1 space-y-1">
                {c.materials.map((m) => (
                  <li key={m.id} className="flex items-start gap-1.5 text-xs">
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[#3F7D4E]" />
                    <span className="min-w-0 break-words">
                      {mat.get(m.id)?.description ?? `Material ${m.id}`}
                      {m.shared ? <span className="ml-1 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">everyone</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">None</p>
            )}
            <p className="mt-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Photos and files</p>
            <p className="mt-1 text-xs">{fileWords(c.files)}</p>
          </div>
        ))}
      </div>
      <div className="px-4 pb-4">
        {waiting ? (
          <div className="rounded-lg border border-[#C77A12] bg-[#C77A12]/10 p-3 text-xs text-[#6E4208]" data-testid="crew-view-nobody">
            <p className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="size-3.5" /> Nobody sees {waiting === 1 ? "this" : "these"} yet
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {v.nobody.materials.map((id) => (
                <li key={id} className="break-words">
                  {mat.get(id)?.description ?? `Material ${id}`}
                </li>
              ))}
              {v.nobody.files.length ? <li>Files: {fileWords(v.nobody.files)}</li> : null}
            </ul>
            <p className="mt-1.5">Pick a crew for each one in Materials or the Job file below, or choose Everyone on this job.</p>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 rounded-lg bg-[#3F7D4E]/10 p-3 text-xs text-[#2D5A38]" data-testid="crew-view-nobody">
            <CheckCircle2 className="size-3.5" /> Every material and file has a crew. Nothing is waiting.
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Every crew always sees the site address, the contacts, the access notes, the Site access photos and the SWMS. Each crew sees only its own labour and pay.
        </p>
      </div>
    </Card>
  );
}
