import * as React from "react";
import { CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { Input } from "./ui/field";
import { useAbnChaseList, useAbnLookup, useAbnRecheck } from "../queries/abnCheck";
import { useInstaller } from "../queries/installers";
import { abnVerdict, NAME_MISMATCH, namesMatch, type CardNames } from "../../api/lib/abn-names";

/*
 * Notes 18.64: the ABN check on an installer card. Admin only: the server
 * sends the check to Admins and nothing to anyone else, so for Office this
 * renders just the plain input.
 *
 * Notes 18.66: the name side of the check always runs on the names in the
 * form right now (short name, full name, trading name), saved or not, with
 * the same rule the server uses (abn-names.ts).
 */

export type AbnCheckView = NonNullable<NonNullable<ReturnType<typeof useInstaller>["data"]>["abnCheck"]>;

const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

export function abnDay(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function when(v: Date | string | null) {
  if (!v) return "never";
  const d = new Date(v);
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Australia/Brisbane" });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/** A few words on why it doesn't pass, for lists. */
export function abnShort(v: { state: string; mismatch: boolean }) {
  switch (v.state) {
    case "missing":
      return "no ABN";
    case "unchecked":
      return "ABN not checked yet";
    case "error":
      return "ABN could not be checked";
    case "cancelled":
      return "ABN cancelled";
    case "not_found":
      return "ABN not found";
    case "invalid":
      return "ABN not valid";
    default:
      return v.mismatch ? "name does not match the ABN" : "ABN does not pass";
  }
}

/** The tick or the warning, in one line. */
export function AbnVerdict({ passes, warning }: { passes: boolean; warning: string | null }) {
  return passes ? (
    <p className="flex items-center gap-1.5 font-medium text-emerald-700">
      <CircleCheck className="size-4" /> ABN active, name matches
    </p>
  ) : (
    <p className="flex items-start gap-1.5 font-medium text-red-700">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {warning ?? "ABN does not pass."}
    </p>
  );
}

type Details = {
  legalName: string | null;
  businessNames: string[];
  status: string | null;
  statusFrom: string | null;
  entityType: string | null;
  gstRegistered: boolean;
  gstFrom: string | null;
  gstTo: string | null;
  regState: string | null;
  postcode: string | null;
};

function DetailRows({ d }: { d: Details }) {
  return (
    <dl className="mt-2 text-[13px]">
      <Row label="Legal name">{d.legalName ?? "-"}</Row>
      <Row label="Business and trading names">{d.businessNames.length ? d.businessNames.join(", ") : "None"}</Row>
      <Row label="Status">
        {d.status === "Active" ? `Active${d.statusFrom ? ` since ${abnDay(d.statusFrom)}` : ""}` : d.status === "Cancelled" ? `Cancelled${d.statusFrom ? ` from ${abnDay(d.statusFrom)}` : ""}` : d.status ?? "-"}
      </Row>
      {d.entityType ? <Row label="Entity">{d.entityType}</Row> : null}
      <Row label="GST">
        {d.gstRegistered
          ? `GST registered from ${abnDay(d.gstFrom)}`
          : d.gstFrom && d.gstTo
            ? `Not GST registered (was ${abnDay(d.gstFrom)} to ${abnDay(d.gstTo)})`
            : "Not GST registered"}
      </Row>
      <Row label="State and postcode">{[d.regState, d.postcode].filter(Boolean).join(" ") || "-"}</Row>
    </dl>
  );
}

/** The saved answer on his card, with Check now. */
export function AbnSavedPanel({ installerId, check, names }: { installerId: number; check: AbnCheckView; names: CardNames }) {
  const recheck = useAbnRecheck();
  // The saved lookup, against the names in the form now.
  const { passes, warning } = abnVerdict(check, names);
  const [error, setError] = React.useState<string | null>(null);
  const hasAnswer = check.status === "Active" || check.status === "Cancelled";

  async function run() {
    setError(null);
    try {
      await recheck.mutateAsync({ installerId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div
      className={
        passes
          ? "rounded-lg border border-emerald-300 bg-emerald-50/60 px-3 py-2 text-sm"
          : "rounded-lg border border-red-300 bg-red-50/60 px-3 py-2 text-sm"
      }
      aria-label="ABN check"
    >
      <div className="flex items-start justify-between gap-3">
        <AbnVerdict passes={passes} warning={warning} />
        {check.state !== "missing" ? (
          <Button size="sm" variant="outline" onClick={run} disabled={recheck.isPending}>
            {recheck.isPending ? <Spinner /> : <RefreshCw className="size-3.5" />}
            Check now
          </Button>
        ) : null}
      </div>
      {hasAnswer ? <DetailRows d={check} /> : null}
      {hasAnswer && check.checkError ? (
        <p className="mt-1 text-xs text-muted-foreground">Last check could not reach the register: {check.checkError} Showing the answer before that.</p>
      ) : null}
      <p className="mt-1.5 text-xs text-muted-foreground">
        {check.legalName ? <>Bills, pay and Xero: <span className="font-medium text-foreground">{check.billName}</span>. </> : null}
        Checked {when(check.checkedAt)}. Rechecked every month.
      </p>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** What the register says for an ABN that has been typed and not saved yet. */
function AbnLivePreview({ abn, names }: { abn: string; names: CardNames }) {
  const [settled, setSettled] = React.useState(abn);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(abn), 500);
    return () => clearTimeout(t);
  }, [abn]);
  const lookup = useAbnLookup({ abn: settled }, digits(settled).length === 11);
  if (digits(abn).length !== 11) return <p className="text-xs text-muted-foreground">An ABN is 11 digits.</p>;
  if (lookup.isPending || settled !== abn) return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner /> Looking it up</p>;
  if (lookup.isError) return <p className="text-xs text-destructive">Could not look it up: {lookup.error.message}</p>;
  const r = lookup.data;
  if (!r.found) {
    const passes = false;
    const warning = r.kind === "not_found" ? "ABN not found on the register." : r.kind === "invalid" ? "Not a valid ABN." : `Could not check: ${r.message}`;
    return (
      <div className="rounded-lg border border-red-300 bg-red-50/60 px-3 py-2 text-sm">
        <AbnVerdict passes={passes} warning={warning} />
        <p className="mt-1 text-xs text-muted-foreground">Looked up live. Saved to his card when you save.</p>
      </div>
    );
  }
  const f = r.found;
  const mismatch = namesMatch(names, f) === false;
  const passes = f.status === "Active" && !mismatch;
  const warning =
    f.status === "Cancelled"
      ? `ABN cancelled${f.statusFrom ? ` from ${abnDay(f.statusFrom)}` : ""}.`
      : f.status !== "Active"
        ? `ABN is ${f.status || "not active"}.`
        : mismatch
          ? NAME_MISMATCH
          : null;
  return (
    <div className={passes ? "rounded-lg border border-emerald-300 bg-emerald-50/60 px-3 py-2 text-sm" : "rounded-lg border border-red-300 bg-red-50/60 px-3 py-2 text-sm"}>
      <AbnVerdict passes={passes} warning={warning} />
      <DetailRows d={{ ...f, regState: f.state }} />
      <p className="mt-1 text-xs text-muted-foreground">Looked up live. Saved to his card when you save.</p>
    </div>
  );
}

/**
 * The ABN input on an installer card. Typing a new ABN looks it up live;
 * once saved, the card shows the stored answer and Check now.
 */
export function AbnField({
  installerId,
  value,
  onChange,
  savedAbn,
  names,
  check,
}: {
  installerId: number;
  value: string;
  onChange: (v: string) => void;
  savedAbn: string | null;
  /** The names in the form now, saved or not. */
  names: CardNames;
  check: AbnCheckView | null;
}) {
  const changed = digits(value) !== digits(savedAbn);
  return (
    <div className="flex flex-col gap-2">
      <Input value={value} inputMode="numeric" placeholder="11 digits" onChange={(e) => onChange(e.target.value)} aria-label="ABN" />
      {check ? (
        changed ? (
          digits(value) ? (
            <AbnLivePreview abn={value} names={names} />
          ) : (
            <p className="text-xs text-red-700">No ABN. He can't invoice from his phone until his ABN passes.</p>
          )
        ) : (
          <AbnSavedPanel installerId={installerId} check={check} names={names} />
        )
      ) : null}
    </div>
  );
}

/** People page, Admin only: every current installer whose ABN is missing or doesn't pass. */
export function AbnChaseList({ onOpen }: { onOpen: (installerId: number) => void }) {
  const list = useAbnChaseList();
  const recheck = useAbnRecheck();
  const [busy, setBusy] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function run(installerId: number) {
    setError(null);
    setBusy(installerId);
    try {
      await recheck.mutateAsync({ installerId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const d = list.data;
  return (
    <Card className="mt-4">
      <CardHeader
        title="ABN checks"
        subtitle={
          d
            ? `${d.passing} of ${d.total} current installers pass. The rest can't invoice from their phone until their ABN passes. Rechecked every month.`
            : "Current installers with a missing or failed ABN."
        }
        action={<TriangleAlert className="size-4 text-muted-foreground" />}
      />
      {list.isPending ? (
        <Loading label="Loading ABN checks" />
      ) : list.isError ? (
        <Empty>Couldn't load the ABN checks. {list.error.message}</Empty>
      ) : !d || d.chase.length === 0 ? (
        <Empty>Every current installer's ABN passes.</Empty>
      ) : (
        <div className="divide-y divide-border" aria-label="ABN chase list">
          {d.chase.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <button type="button" className="min-w-40 text-left font-medium text-primary hover:underline" onClick={() => onOpen(r.id)}>
                {r.name}
              </button>
              <span className="tabular text-muted-foreground">{r.abn || "No ABN"}</span>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-red-700">
                <TriangleAlert className="size-3.5 shrink-0" />
                <span className="truncate">{r.warning}</span>
              </span>
              {r.legalName ? <span className="text-xs text-muted-foreground">{r.legalName}</span> : null}
              {r.state !== "missing" ? (
                <Button size="sm" variant="outline" onClick={() => run(r.id)} disabled={busy !== null}>
                  {busy === r.id ? <Spinner /> : <RefreshCw className="size-3.5" />}
                  Check now
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => onOpen(r.id)}>
                  Add ABN
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {error ? <p className="px-4 pb-3 text-xs text-destructive">{error}</p> : null}
    </Card>
  );
}
