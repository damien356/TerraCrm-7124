import * as React from "react";
import { Link, useLocation } from "wouter";
import { CornerDownRight, LifeBuoy, Trash2 } from "lucide-react";
import { Card, CardHeader, Empty, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import {
  useAddCallbackCost,
  useCallbackChain,
  useCallbackCosts,
  useCallbackOptions,
  useCreateCallback,
  useOriginalJob,
  useRemoveCallbackCost,
  useSetCallbackCause,
  useSetCallbackChargeable,
} from "../queries/callbacks";
import { useInstallers } from "../queries/installers";
import { repairRef } from "../../api/lib/refs";

/**
 * CALLBACKS on the job page. A callback is a normal job linked to the
 * original, shown as #3981-C1. Cause and chargeable are for Admin and Office.
 * Rework cost is Admin only. The crew never sees any of this.
 */

export type CallbackJob = {
  id: number;
  number: number;
  displayNumber: string | null;
  parentJobId: number | null;
  callbackCause: string | null;
  callbackChargeable: boolean | null;
  callbackPayInstaller: boolean | null;
};

const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2 });

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "#188000", "R188000-1" for a repair, "#3981-C1" for an old callback. */
export const jobLabel = (j: { number: number; displayNumber?: string | null }) =>
  j.displayNumber && /^R\d/.test(j.displayNumber) ? j.displayNumber : `#${j.displayNumber || j.number}`;

/* ------------------------------ pay question ------------------------------ */

/** Installer error only. No default: the office answers it every time. */
function PayInstallerChoice({
  value,
  onChange,
  name,
}: {
  value: boolean | null;
  onChange: (v: boolean) => void;
  name: string;
}) {
  return (
    <fieldset className="rounded-md border border-border px-3 py-2.5">
      <legend className="px-1 text-xs font-medium">Pay the installer for this visit?</legend>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" name={name} aria-label="Yes, pay them" checked={value === true} onChange={() => onChange(true)} />
          Yes, pay them
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={name} aria-label="No, fix it at their cost" checked={value === false} onChange={() => onChange(false)} />
          No, fix it at their cost
        </label>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        "No" sets the visit pay to $0. Nothing is charged to the installer.
      </p>
    </fieldset>
  );
}

/* ----------------------------- create callback ---------------------------- */

export function CreateCallbackModal({
  job,
  open,
  onClose,
}: {
  job: CallbackJob;
  open: boolean;
  onClose: () => void;
}) {
  const [, navigate] = useLocation();
  const options = useCallbackOptions();
  const chain = useCallbackChain(open ? job.id : null);
  const installers = useInstallers();
  const create = useCreateCallback();

  const [cause, setCause] = React.useState("");
  const [chargeable, setChargeable] = React.useState<"" | "yes" | "no">("");
  const [pay, setPay] = React.useState<boolean | null>(null);
  const [installer, setInstaller] = React.useState("original");
  const [problem, setProblem] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setCause("");
    setChargeable("");
    setPay(null);
    setInstaller("original");
    setProblem("");
    setError(null);
  }, [open]);

  const original = chain.data?.originalInstaller ?? null;
  const rootLabel = chain.data?.root ? jobLabel(chain.data.root) : jobLabel(job);
  const nextSeq = (chain.data?.callbacks.length ?? 0) + 1;
  const isInstallerError = cause === "installer_error";
  const ready = cause && chargeable && (!isInstallerError || pay !== null);

  async function submit() {
    setError(null);
    try {
      const row = await create.mutateAsync({
        jobId: job.id,
        cause: cause as "installer_error",
        chargeable: chargeable === "yes",
        payInstaller: isInstallerError ? pay : null,
        problem,
        ...(installer === "original" ? {} : { installerId: installer === "none" ? null : Number(installer) }),
      });
      onClose();
      navigate(`/jobs/${row.id}`);
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Create callback ${chain.data?.root ? repairRef(chain.data.root.number, nextSeq) : ""}`.trim()}
      subtitle={`A return visit on ${rootLabel}. It copies the people and the site, and adds one callback visit. Products, notes and photos stay on the original and show read only.`}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!ready || create.isPending}>
            {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Create callback
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cause">
            <Select
              value={cause}
              onChange={(e) => {
                setCause(e.target.value);
                setPay(null);
              }}
            >
              <option value="">Pick a cause</option>
              {(options.data?.causes ?? []).map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Chargeable to the client?">
            <Select value={chargeable} onChange={(e) => setChargeable(e.target.value as typeof chargeable)}>
              <option value="">Pick one</option>
              <option value="yes">Chargeable. Quote it like any job.</option>
              <option value="no">Not chargeable. Nothing is billed.</option>
            </Select>
          </Field>
        </div>
        {isInstallerError ? <PayInstallerChoice name="cb-create-pay" value={pay} onChange={setPay} /> : null}
        <Field label="Who does the fix">
          <Select value={installer} onChange={(e) => setInstaller(e.target.value)}>
            <option value="original">{original ? `${original.name} (did the original work)` : "Whoever did the original work"}</option>
            <option value="none">Leave unassigned. Book it later.</option>
            {(installers.data ?? [])
              .filter((i) => i.id !== original?.id)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="What the client reported" hint="Goes on the callback and on the visit the crew sees.">
          <Textarea rows={3} value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="Two boards lifting by the kitchen bench." />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

/* --------------------------- banner on a callback --------------------------- */

export function CallbackBanner({ job }: { job: CallbackJob }) {
  const options = useCallbackOptions();
  const chain = useCallbackChain(job.id);
  const setCause = useSetCallbackCause();
  const setChargeable = useSetCallbackChargeable();
  const [editing, setEditing] = React.useState(false);
  const [cause, setCauseValue] = React.useState(job.callbackCause ?? "");
  const [pay, setPay] = React.useState<boolean | null>(job.callbackPayInstaller);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setCauseValue(job.callbackCause ?? "");
    setPay(job.callbackPayInstaller);
  }, [job.callbackCause, job.callbackPayInstaller]);

  const root = chain.data?.root ?? null;
  const original = chain.data?.originalInstaller ?? null;
  const causeLabel = (options.data?.causes ?? []).find((c) => c.key === job.callbackCause)?.label ?? "No cause set";
  const isInstallerError = cause === "installer_error";

  async function saveCause() {
    setError(null);
    try {
      await setCause.mutateAsync({ jobId: job.id, cause: cause as "installer_error", payInstaller: isInstallerError ? pay : null });
      setEditing(false);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function flipChargeable() {
    setError(null);
    try {
      await setChargeable.mutateAsync({ jobId: job.id, chargeable: !job.callbackChargeable });
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Card className="border-[var(--gold)]/50 bg-[var(--gold-pale)]/25 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <LifeBuoy className="mt-0.5 size-4 text-[var(--gold)]" />
          <div>
            <p className="text-sm font-semibold">
              Callback of{" "}
              {root ? (
                <Link to={`/jobs/${root.id}`} className="text-primary hover:underline">
                  #{root.number}
                </Link>
              ) : (
                "the original job"
              )}
              {root?.title ? <span className="font-normal text-muted-foreground"> · {root.title}</span> : null}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {original ? `Original work by ${original.name}. ` : ""}The crew sees this as a normal job. They never see the cause or who pays.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge colour={job.callbackCause === "installer_error" ? "#B4442C" : "#5B6B7A"}>{causeLabel}</Badge>
          {job.callbackCause === "installer_error" ? (
            <Badge colour={job.callbackPayInstaller ? "#2F7D4F" : "#B4442C"}>
              {job.callbackPayInstaller ? "Installer paid" : "Installer not paid"}
            </Badge>
          ) : null}
          <Badge colour={job.callbackChargeable ? "#2F7D4F" : "#8A6D1E"}>
            {job.callbackChargeable ? "Chargeable" : "Not chargeable"}
          </Badge>
        </div>
      </div>

      {editing ? (
        <div className="mt-3 grid gap-3 border-t border-border pt-3">
          <Field label="Cause" className="max-w-xs">
            <Select
              value={cause}
              onChange={(e) => {
                setCauseValue(e.target.value);
                setPay(null);
              }}
            >
              {(options.data?.causes ?? []).map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          {isInstallerError ? <PayInstallerChoice name={`cb-${job.id}-pay`} value={pay} onChange={setPay} /> : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={saveCause} disabled={!cause || (isInstallerError && pay === null) || setCause.isPending}>
              {setCause.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
              Save cause
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Change cause
          </Button>
          <Button size="sm" variant="outline" onClick={flipChargeable} disabled={setChargeable.isPending}>
            {setChargeable.isPending ? <Spinner /> : null}
            {job.callbackChargeable ? "Mark not chargeable" : "Mark chargeable"}
          </Button>
        </div>
      )}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </Card>
  );
}

/* ------------------------ callbacks on the original ------------------------ */

export function CallbacksListCard({ jobId }: { jobId: number }) {
  const chain = useCallbackChain(jobId);
  const options = useCallbackOptions();
  const list = chain.data?.callbacks ?? [];
  if (!list.length) return null;
  const labelOf = (k: string | null) => (options.data?.causes ?? []).find((c) => c.key === k)?.label ?? "No cause set";
  return (
    <Card>
      <CardHeader title="Callbacks" subtitle="Return visits on this job." />
      <ul className="divide-y divide-border">
        {list.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
              <Link to={`/jobs/${c.id}`} className="font-medium text-primary hover:underline">
                {jobLabel(c)}
              </Link>
              <span className="truncate text-xs text-muted-foreground">{labelOf(c.cause)}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {c.chargeable === false ? <Badge colour="#8A6D1E">Free</Badge> : null}
              {c.status?.name ? <Badge colour={c.status.colour}>{c.status.name}</Badge> : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* --------------------------- original job, read only --------------------------- */

export function OriginalJobCard({ jobId }: { jobId: number }) {
  const original = useOriginalJob(jobId);
  const d = original.data;
  return (
    <Card>
      <CardHeader title="From the original job" subtitle="Read only. Products, notes and photos as they were." />
      {original.isLoading ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : !d ? (
        <Empty>Couldn't load the original job.</Empty>
      ) : (
        <div className="grid gap-3 px-4 py-3">
          <div>
            <p className="label-xs">Products</p>
            {d.materials.length ? (
              <ul className="mt-1 space-y-0.5 text-sm">
                {d.materials.map((m) => (
                  <li key={m.id} className="flex justify-between gap-2">
                    <span className="truncate">{m.description}</span>
                    <span className="tabular shrink-0 text-xs text-muted-foreground">
                      {m.qty} {m.unit}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">No products recorded.</p>
            )}
          </div>
          <div>
            <p className="label-xs">Notes</p>
            {d.notes.length ? (
              <ul className="mt-1 max-h-40 space-y-1.5 overflow-y-auto text-sm">
                {d.notes.map((n) => (
                  <li key={n.id}>
                    {n.detail}
                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                      {n.actorName || "System"}, {new Date(n.createdAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">No notes.</p>
            )}
          </div>
          <div>
            <p className="label-xs">Photos ({d.media.length})</p>
            {d.media.length ? (
              <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                {d.media.slice(0, 24).map((m) =>
                  m.kind === "photo" ? (
                    <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="aspect-square overflow-hidden rounded bg-muted">
                      <img src={m.url} alt={m.caption ?? m.filename ?? "Original job photo"} className="size-full object-cover" />
                    </a>
                  ) : (
                    <a
                      key={m.id}
                      href={m.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex aspect-square items-center justify-center rounded bg-muted p-1 text-center text-[10px] text-muted-foreground"
                    >
                      {m.kind === "video" ? "Video" : (m.filename ?? "File")}
                    </a>
                  ),
                )}
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">No photos on the original.</p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------ rework cost ------------------------------ */

/** Admin only. Tracked and reported against the original installer. Never charged to them. */
export function ReworkCostCard({ jobId }: { jobId: number }) {
  const costs = useCallbackCosts(jobId);
  const options = useCallbackOptions();
  const installers = useInstallers(true);
  const add = useAddCallbackCost();
  const remove = useRemoveCallbackCost();
  const [form, setForm] = React.useState({ kind: "labour", description: "", amount: "" });
  const [error, setError] = React.useState<string | null>(null);
  const d = costs.data;
  const kindLabel = (k: string) => (options.data?.costKinds ?? []).find((c) => c.key === k)?.label ?? k;
  const nameOf = (id: number | null) => (id ? ((installers.data ?? []).find((i) => i.id === id)?.name ?? null) : null);

  async function submit() {
    setError(null);
    try {
      await add.mutateAsync({
        jobId,
        kind: form.kind as "labour",
        description: form.description,
        amount: Number(form.amount),
      });
      setForm({ kind: form.kind, description: "", amount: "" });
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Card>
      <CardHeader
        title="Rework cost"
        subtitle={
          d?.original
            ? `Admin only. Held against ${d.original.name} for the report. Never charged to them.`
            : "Admin only. Tracked for the report. Never charged to anyone."
        }
        action={d ? <span className="tabular text-sm font-semibold">{money(d.total)}</span> : null}
      />
      {d?.items.length ? (
        <ul className="divide-y divide-border">
          {d.items.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-4 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  {kindLabel(c.kind)}
                  {c.description ? <span className="text-muted-foreground">, {c.description}</span> : null}
                </p>
                {c.installerId && c.installerId !== d.original?.id ? (
                  <p className="text-[11px] text-muted-foreground">Against {c.installerName ?? nameOf(c.installerId) ?? "installer"}</p>
                ) : null}
              </div>
              <span className="tabular text-sm">{money(c.amount)}</span>
              <button
                type="button"
                title="Remove cost"
                onClick={() => remove.mutate({ id: c.id })}
                className="text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-2 border-t border-border px-4 py-3">
        <div className="flex gap-2">
          <Select className="w-auto" value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
            {(options.data?.costKinds ?? []).map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </Select>
          <Input
            type="number"
            inputMode="decimal"
            placeholder="$ ex GST"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
          />
        </div>
        <Input
          placeholder="What it was for"
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
        <Button size="sm" variant="secondary" onClick={submit} disabled={!form.amount || Number(form.amount) < 0 || add.isPending}>
          Add cost
        </Button>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Card>
  );
}
