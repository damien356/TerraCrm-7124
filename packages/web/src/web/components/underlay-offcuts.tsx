import * as React from "react";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select } from "./ui/field";
import { Modal } from "./ui/modal";
import { newRequestKey } from "../queries/stock";
import {
  type MaterialOffcuts,
  useAutoApplyOffcuts,
  useIssueOffcut,
  useJobOffcuts,
  useRecordOffcut,
  useStockLocations,
  useUndoOffcut,
  useUseOffcut,
} from "../queries/stockOffcuts";

/*
 * Underlay offcuts on a job's materials (Damien, 20 Nov 2026, quote 188123 plan).
 *
 * Ops suggests an offcut and pre-ticks it. The office can untick it. The
 * office records an offcut that came back. The cost moves to the next job.
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));
const unitWord = (u: string) => (u === "m2" ? "m²" : u === "lm" ? "m" : u);

/** One fetch for the whole job. Asks Ops to hold offcuts once when the page opens. */
export function useOffcutsOnJob(jobId: number) {
  const q = useJobOffcuts(jobId);
  const auto = useAutoApplyOffcuts();
  const ran = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!(jobId > 0) || ran.current === jobId) return;
    ran.current = jobId;
    auto.mutate({ jobId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
  return q;
}

export function MaterialOffcutsRow({ data, unit, keepMinM }: { data: MaterialOffcuts | undefined; unit: string; keepMinM: number }) {
  const use = useUseOffcut();
  const undo = useUndoOffcut();
  const issue = useIssueOffcut();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [recording, setRecording] = React.useState(false);
  if (!data || !data.eligible) return null;
  const busy = use.isPending || undo.isPending || issue.isPending;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg(done);
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const u = unitWord(unit);
  const hasAnything = data.held.length || data.could.length || data.back.length;

  return (
    <div className="basis-full rounded-md bg-secondary/50 px-3 py-2 text-xs" data-offcuts-for={data.materialId}>
      {data.held.map((h) => (
        <div key={h.holdId} className="flex flex-wrap items-center gap-2 py-0.5">
          <label className={`flex items-center gap-2 ${h.canUndo ? "cursor-pointer" : ""}`}>
            <Checkbox
              checked
              disabled={!h.canUndo || busy}
              onChange={() => run(() => undo.mutateAsync({ holdId: h.holdId }), `Unticked ${h.code}. It is free for other jobs again.`)}
            />
            <span>
              Use offcut <span className="font-mono">{h.code}</span>: {h.metres} m, covers {h.covers} {u}
              {h.status === "issued" ? ". Taken to the job." : "."}
            </span>
          </label>
          {h.status === "reserved" && data.onPo ? <span className="text-muted-foreground">({data.onPo} was worked out with it.)</span> : null}
          {h.canIssue ? (
            <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy} onClick={() => run(() => issue.mutateAsync({ holdId: h.holdId }), `${h.code} taken to the job.`)}>
              Taken to job
            </Button>
          ) : null}
        </div>
      ))}
      {data.could.map((c) => (
        <label key={c.itemId} className="flex cursor-pointer items-center gap-2 py-0.5">
          <Checkbox
            checked={false}
            disabled={busy}
            onChange={() => run(() => use.mutateAsync({ jobMaterialId: data.materialId, itemId: c.itemId }), `${c.code} is held for this job.`)}
          />
          <span>
            Use offcut <span className="font-mono">{c.code}</span>: {c.free} m free
          </span>
        </label>
      ))}
      {data.back.map((b) => (
        <p key={b.itemId} className="py-0.5 text-muted-foreground">
          Offcut back from this job: <span className="font-mono">{b.code}</span>, {b.metres} m{b.toCheck ? ", waiting for Admin approval" : ""}.
        </p>
      ))}
      <div className={`flex flex-wrap items-center gap-2 ${hasAnything ? "pt-1" : ""}`}>
        {!hasAnything ? <span className="text-muted-foreground">No underlay offcuts in stock for this.</span> : null}
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setRecording(true)}>
          Offcut came back
        </Button>
      </div>
      {msg ? <p className="pt-1">{msg}</p> : null}
      {recording ? <RecordOffcutModal data={data} keepMinM={keepMinM} onClose={() => setRecording(false)} onDone={(t) => setMsg(t)} /> : null}
    </div>
  );
}

function RecordOffcutModal({ data, keepMinM, onClose, onDone }: { data: MaterialOffcuts; keepMinM: number; onClose: () => void; onDone: (text: string) => void }) {
  const record = useRecordOffcut();
  const locations = useStockLocations(true);
  const [metres, setMetres] = React.useState("");
  const [width, setWidth] = React.useState(data.widthM != null ? String(data.widthM) : "");
  const [locationId, setLocationId] = React.useState("");
  const [note, setNote] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const keyRef = React.useRef(newRequestKey());

  const save = async () => {
    setErr(null);
    const m = Number(metres);
    if (!(m > 0)) return setErr("Enter the metres that came back.");
    const w = Number(width);
    try {
      const out = await record.mutateAsync({
        jobMaterialId: data.materialId,
        metres: m,
        widthM: w > 0 ? w : null,
        locationId: locationId ? Number(locationId) : null,
        note: note.trim() || undefined,
        requestKey: keyRef.current,
      });
      onDone(out.note);
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Offcut came back"
      subtitle={`Offcuts under ${keepMinM} m are not kept as stock. They get a note on the job.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={record.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Length (m)">
          <Input inputMode="decimal" autoFocus value={metres} onChange={(e) => setMetres(e.target.value)} />
        </Field>
        <Field label="Width (m)">
          <Input inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} />
        </Field>
        <Field label="Where it is">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Not sure yet</option>
            {(locations.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {err ? <p className="mt-3 text-sm text-destructive">{err}</p> : null}
    </Modal>
  );
}
