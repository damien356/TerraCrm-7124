import * as React from "react";
import { Link } from "wouter";
import { Check, Send, Square } from "lucide-react";
import { Card, CardHeader, Loading } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Select } from "./ui/field";
import { errorText } from "./public-shell";
import { useUpdateJob } from "../queries/jobs";
import { useUpdateSite } from "../queries/companies";
import { useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";
import { usePrepOnMyWay, usePrepPlan, usePrepRetry, usePrepStop, usePrepTickApt, usePrepUnstop, useSetPrepOn } from "../queries/prep";
import { APT_CHECKS, PROPERTY_TYPES, propertyTypeAnswered } from "../../api/lib/property-types";
import { dayDate } from "../../api/lib/prep-templates";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
 * Client prep on the job page (notes 18.56): the property type and furniture
 * answers in the facts row, and the panel that shows what goes to the client,
 * when, and what it says.
 * ------------------------------------------------------------------------- */

const red = "border-destructive bg-destructive/5 text-destructive";

/** Property type (on the site) and Furniture moving, red until answered. */
export function JobPrepFacts({ job }: { job: { id: number; furnitureMoving: boolean | null; site: { id: number; propertyType: string } | null } }) {
  const updateJob = useUpdateJob();
  const updateSite = useUpdateSite();
  const [error, setError] = React.useState<string | null>(null);
  const queryClient = useQueryClient();
  const done = () => {
    setError(null);
    void queryClient.invalidateQueries({ queryKey: orpc.prep.key() });
  };
  const pt = job.site?.propertyType ?? "";
  const ptOk = propertyTypeAnswered(pt);
  return (
    <div className="grid gap-2">
      <div>
        <p className={cn("label-xs", !ptOk && "text-destructive")}>Property type</p>
        {job.site ? (
          <Select
            aria-label="Property type"
            className={cn("mt-0.5 h-8", !ptOk && red)}
            value={ptOk ? pt : ""}
            onChange={(e) =>
              e.target.value &&
              updateSite.mutate({ id: job.site!.id, propertyType: e.target.value }, { onSuccess: done, onError: (x) => setError(errorText(x)) })
            }
          >
            <option value="">Not answered</option>
            {PROPERTY_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        ) : (
          <p className="mt-0.5 text-xs text-destructive">Add the site first.</p>
        )}
      </div>
      <div>
        <p className={cn("label-xs", job.furnitureMoving == null && "text-destructive")}>Furniture moving</p>
        <Select
          aria-label="Furniture moving"
          className={cn("mt-0.5 h-8", job.furnitureMoving == null && red)}
          value={job.furnitureMoving == null ? "" : job.furnitureMoving ? "yes" : "no"}
          onChange={(e) =>
            e.target.value &&
            updateJob.mutate(
              { id: job.id, furnitureMoving: e.target.value === "yes" },
              { onSuccess: done, onError: (x) => setError(errorText(x)) },
            )
          }
        >
          <option value="">Not answered</option>
          <option value="yes">Yes, we move it (2-man crews)</option>
          <option value="no">No, rooms cleared by the client</option>
        </Select>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

const KIND_LABEL = { install_email: "Install email", day_sms: "Day before text", omw_sms: "On my way text" } as const;

const STATUS_LABEL: Record<string, string> = {
  waiting: "Waiting",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  "no email": "No email on the card",
  "no mobile": "No mobile on the card",
  "texts off": "Client texts off in Settings",
};

const STATUS_COLOUR: Record<string, string | undefined> = { sent: "#2f7d4f", failed: "#b23b2c", "no email": "#b23b2c", "no mobile": "#b23b2c", "texts off": "#9a6b12" };

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const when = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString("en-AU", { day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit", timeZone: "Australia/Brisbane" }) : "";

function Preview({ subject, body }: { subject: string | null; body: string }) {
  return (
    <details className="mt-1.5 text-xs">
      <summary className="cursor-pointer text-primary">What it says</summary>
      <div className="mt-1.5 rounded-md border border-border bg-secondary/40 px-3 py-2">
        {subject ? <p className="mb-1.5 font-medium">{subject}</p> : null}
        <p className="whitespace-pre-wrap text-muted-foreground">{body}</p>
      </div>
    </details>
  );
}

export function JobPrepCard({ jobId }: { jobId: number }) {
  const plan = usePrepPlan(jobId);
  const stop = usePrepStop();
  const unstop = usePrepUnstop();
  const retry = usePrepRetry();
  const omw = usePrepOnMyWay();
  const setOn = useSetPrepOn();
  const tick = usePrepTickApt();
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  const done = (text: string) => () => setNote({ ok: true, text });
  const fail = (e: unknown) => setNote({ ok: false, text: errorText(e) });

  if (plan.isLoading) {
    return (
      <Card>
        <CardHeader title="Client prep" />
        <Loading />
      </Card>
    );
  }
  const p = plan.data;
  if (!p) return null;

  const today = p.days.find((d) => d.date === p.today);
  const switchValue = p.prepOnSet == null ? "default" : p.prepOnSet ? "on" : "off";

  return (
    <Card id="client-prep" className="scroll-mt-4">
      <CardHeader
        title="Client prep"
        subtitle={`Install email 3 days before, a text the day before each day, and On my way. Sends from ${p.sendHour > 12 ? `${p.sendHour - 12}pm` : `${p.sendHour}am`}.`}
        action={
          <Select
            aria-label="Client prep on this job"
            className="h-8 w-auto text-xs"
            value={switchValue}
            disabled={setOn.isPending}
            onChange={(e) => {
              const v = e.target.value;
              setOn.mutate({ jobId, on: v === "default" ? null : v === "on" }, { onSuccess: done("Saved."), onError: fail });
            }}
          >
            <option value="default">{p.builder ? "Default (off, builder job)" : "Default (on)"}</option>
            <option value="on">On for this job</option>
            <option value="off">Off for this job</option>
          </Select>
        }
      />
      <div className="grid gap-3 px-4 py-3 text-sm">
        {p.hold ? (
          <p className={cn("rounded-md px-3 py-2 text-xs", p.missing.length ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground")}>{p.hold}</p>
        ) : null}
        {note ? <p className={cn("text-xs", note.ok ? "text-muted-foreground" : "text-destructive")}>{note.text}</p> : null}

        {p.people.length ? (
          <p className="text-xs text-muted-foreground">
            To: {p.people.map((x) => `${x.name} (${x.why})`).join(", ")}
          </p>
        ) : null}

        {p.items.length ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {p.items.map((it) => {
              const anyFailed = it.people.some((x) => x.status === "failed");
              const args = { jobId, kind: it.kind, forDate: it.forDate };
              return (
                <li key={`${it.kind}-${it.forDate}`} className="px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">
                        {KIND_LABEL[it.kind]} for {dayDate(it.forDate)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {it.stopped
                          ? `Stopped by ${it.stopped.byName} ${when(it.stopped.at)}`
                          : it.sendOn <= p.today
                            ? "Goes today (or next send time)"
                            : `Goes ${ddmm(it.sendOn)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {anyFailed && !it.stopped ? (
                        <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate(args, { onSuccess: done("Sent again."), onError: fail })}>
                          <Send className="size-3.5" /> Retry
                        </Button>
                      ) : null}
                      {it.stopped ? (
                        <Button size="sm" variant="outline" disabled={unstop.isPending} onClick={() => unstop.mutate(args, { onSuccess: done("Back on."), onError: fail })}>
                          Put back on
                        </Button>
                      ) : it.people.every((x) => x.status === "sent") && it.people.length ? null : (
                        <Button size="sm" variant="outline" disabled={stop.isPending} onClick={() => stop.mutate(args, { onSuccess: done("Stopped."), onError: fail })}>
                          <Square className="size-3.5" /> Stop
                        </Button>
                      )}
                    </div>
                  </div>
                  {it.people.length ? (
                    <ul className="mt-1.5 grid gap-1">
                      {it.people.map((x) => (
                        <li key={x.key} className="flex flex-wrap items-center gap-2 text-xs">
                          <span>{x.name}</span>
                          <span className="text-muted-foreground">{x.to ?? ""}</span>
                          <Badge colour={STATUS_COLOUR[x.status]}>{STATUS_LABEL[x.status] ?? x.status}</Badge>
                          {x.at && x.status !== "waiting" ? <span className="text-muted-foreground">{when(x.at)}</span> : null}
                          {x.detail ? <span className="text-destructive">{x.detail}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <Preview subject={it.preview.subject} body={it.preview.body} />
                </li>
              );
            })}
          </ul>
        ) : p.example ? (
          <div className="text-xs text-muted-foreground">
            <p>No install booked yet. Once one is, the messages show here. This is what they would say for {dayDate(p.example.date)}:</p>
            <Preview subject={p.example.email.subject} body={p.example.email.body} />
            <Preview subject={null} body={p.example.sms} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Nothing left to send. Every install day is today or past.</p>
        )}

        {p.unit ? (
          <div>
            <p className="label-xs">Apartment checklist</p>
            <div className="mt-1 grid gap-1">
              {APT_CHECKS.map(([key, label]) => {
                const c = p.aptChecks[key];
                return (
                  <label key={key} htmlFor={`apt_${key}`} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={`apt_${key}`}
                      checked={!!c}
                      disabled={tick.isPending}
                      onChange={(e) => tick.mutate({ jobId, key, done: e.target.checked }, { onError: fail })}
                    />
                    {label}
                    {c ? <span className="text-xs text-muted-foreground">{`${c.by}, ${when(c.at)}`}</span> : null}
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {today ? (
            <Button
              size="sm"
              disabled={omw.isPending || !p.on || p.cancelled}
              onClick={() =>
                omw.mutate(
                  { taskId: today.taskId },
                  { onSuccess: (r) => setNote({ ok: true, text: r.sent ? "On my way text sent." : "Already sent today." }), onError: fail },
                )
              }
            >
              <Check className="size-3.5" /> On my way
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {today ? "Texts the client that the installer is on the way. Once a day." : "On my way shows here on an install day."}
          </p>
        </div>

        {p.log.length ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Sent so far ({p.log.length})</summary>
            <ul className="mt-1.5 grid gap-1">
              {p.log.map((l) => (
                <li key={l.id}>
                  {KIND_LABEL[l.kind]} for {ddmm(l.forDate)} to {l.to}: {STATUS_LABEL[l.status] ?? l.status}, {when(l.at)}
                  {l.detail ? ` (${l.detail})` : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Wording and times are in <Link href="/settings?tab=prep" className="text-primary hover:underline">Settings, Client prep</Link>.
        </p>
      </div>
    </Card>
  );
}
