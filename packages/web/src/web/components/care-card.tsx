import * as React from "react";
import { Link } from "wouter";
import { HeartHandshake, RotateCcw } from "lucide-react";
import { Card, CardHeader } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Select } from "./ui/field";
import { errorText } from "./public-shell";
import { useCareJob, useCareRetryJob, useCareSetJob, useCareWoolAnswer } from "../queries/care";

/**
 * The care card on a job (section 18.37). Shows once the job is Completed:
 * who gets the care emails, what went down, and the one-tap wool question
 * the emails wait for on a carpet job.
 */

const STATE_TEXT: Record<string, { label: string; colour?: string }> = {
  added: { label: "In the care emails", colour: "#3F7D3A" },
  waiting_wool: { label: "Waiting on the wool answer", colour: "#D08A1E" },
  skipped: { label: "Skipped", colour: "#7A736D" },
};

export function CareCard({ jobId, isAdmin }: { jobId: number; isAdmin: boolean }) {
  const q = useCareJob(jobId);
  const wool = useCareWoolAnswer();
  const retry = useCareRetryJob();
  const setJob = useCareSetJob();
  const [editing, setEditing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [floors, setFloors] = React.useState<string[]>([]);
  const [fibre, setFibre] = React.useState("");
  const [pile, setPile] = React.useState("");
  const [landlord, setLandlord] = React.useState("auto");

  const d = q.data;
  if (!d || d.callback || (!d.completed && !d.careState)) return null;

  const state = STATE_TEXT[d.careState];
  const askWool = d.careState === "waiting_wool" || (d.hasCarpet && (d.fibre === "" || d.fibre === "unknown") && d.detectedFibre === "unknown");

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  }

  function startEdit() {
    if (!d) return;
    setFloors(d.floorsSet && d.floorsSet.length ? d.floorsSet : d.floors);
    setFibre(d.fibre);
    setPile(d.pile);
    setLandlord(d.careLandlord === null ? "auto" : d.careLandlord ? "yes" : "no");
    setEditing(true);
  }

  async function saveEdit() {
    if (!d) return;
    await act(async () => {
      await setJob.mutateAsync({
        jobId,
        floors: floors.length ? floors : null,
        fibre: fibre as never,
        pile: pile as never,
        landlord: landlord === "auto" ? null : landlord === "yes",
      });
      setEditing(false);
    });
  }

  return (
    <Card>
      <CardHeader
        title="Care emails"
        subtitle="Plain emails from Damien to the homeowner over the next few years."
        action={state ? <Badge colour={state.colour}>{state.label}</Badge> : <Badge>Not looked at yet</Badge>}
      />
      <div className="space-y-3 px-4 py-3 text-sm">
        {askWool ? (
          <div className="rounded-md border border-[#D08A1E]/40 bg-[#D08A1E]/10 px-3 py-2.5">
            <p className="font-medium">Is this carpet wool?</p>
            <p className="mb-2 text-xs text-muted-foreground">The care emails wait for the answer. Wool gets its own care tips.</p>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" disabled={wool.isPending} onClick={() => act(() => wool.mutateAsync({ jobId, answer: "wool" }))}>
                Yes
              </Button>
              <Button size="sm" variant="outline" disabled={wool.isPending} onClick={() => act(() => wool.mutateAsync({ jobId, answer: "wool_blend" }))}>
                Wool blend
              </Button>
              <Button size="sm" variant="outline" disabled={wool.isPending} onClick={() => act(() => wool.mutateAsync({ jobId, answer: "not_wool" }))}>
                No
              </Button>
            </div>
          </div>
        ) : null}

        <div>
          <p className="label-xs">Goes to</p>
          {d.person ? (
            <p>
              {d.person.name || "No name"}
              {d.person.email ? <span className="text-muted-foreground">, {d.person.email}</span> : <span className="text-destructive">, no email</span>}
              {d.person.landlord ? <span className="text-muted-foreground"> (landlord)</span> : null}
            </p>
          ) : (
            <p className="text-muted-foreground">Nobody: {d.noPersonReason}</p>
          )}
          {d.member ? (
            <p className="text-xs text-muted-foreground">
              {d.member.status === "active" ? "In the series" : d.member.status === "unsubscribed" ? "Unsubscribed" : "Taken out of the series"}, {d.member.sent}{" "}
              {d.member.sent === 1 ? "email" : "emails"} so far.{" "}
              {isAdmin ? (
                <Link to="/marketing/care" className="text-primary hover:underline">
                  Open Care emails
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>

        {!editing ? (
          <div>
            <p className="label-xs">What went down</p>
            <p>
              {d.floors.length ? d.floors.map((f) => d.options.floors.find((o) => o.value === f)?.label ?? f).join(", ") : "Could not tell"}
              {d.floorsFrom ? <span className="text-xs text-muted-foreground"> (from {d.floorsFrom})</span> : null}
            </p>
            {d.hasCarpet ? (
              <p className="text-xs text-muted-foreground">
                Fibre:{" "}
                {d.fibre
                  ? `${d.options.fibres.find((o) => o.value === d.fibre)?.label ?? d.fibre}, set on the job`
                  : d.detectedFibre && d.detectedFibre !== "unknown" && d.fibreFrom && d.fibreFrom !== "none"
                    ? `${d.options.fibres.find((o) => o.value === d.detectedFibre)?.label ?? d.detectedFibre}, from ${d.fibreFrom}`
                    : "not known yet"}
                . Pile:{" "}
                {d.options.piles.find((o) => o.value === (d.pile || d.detectedPile))?.label ?? "not known"}.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="label-xs">What went down</p>
            <div className="grid grid-cols-2 gap-1">
              {d.options.floors.map((o) => (
                <label key={o.value} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={floors.includes(o.value)}
                    onChange={(e) => setFloors((f) => (e.target.checked ? [...f, o.value] : f.filter((x) => x !== o.value)))}
                  />
                  {o.label}
                </label>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Fibre">
                <Select value={fibre} onChange={(e) => setFibre(e.target.value)}>
                  <option value="">Work it out</option>
                  {d.options.fibres.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Pile">
                <Select value={pile} onChange={(e) => setPile(e.target.value)}>
                  <option value="">Work it out</option>
                  {d.options.piles.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Landlord">
                <Select value={landlord} onChange={(e) => setLandlord(e.target.value)}>
                  <option value="auto">From the tags</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">No floors ticked goes back to working it out from the quote.</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={saveEdit} disabled={setJob.isPending}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {d.careNote && d.careState !== "waiting_wool" && d.careNote !== d.noPersonReason ? <p className="text-xs text-muted-foreground">{d.careNote}</p> : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {!editing ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={startEdit}>
              Change
            </Button>
            {d.careState !== "added" && d.careState !== "waiting_wool" ? (
              <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => act(() => retry.mutateAsync({ jobId }))}>
                {d.careState === "skipped" ? <RotateCcw className="size-3.5" /> : <HeartHandshake className="size-3.5" />}
                {d.careState === "skipped" ? "Try again" : "Add now"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {!d.engineOn ? <p className="text-xs text-muted-foreground">The care emails are switched off, so nothing sends yet.</p> : null}
      </div>
    </Card>
  );
}
