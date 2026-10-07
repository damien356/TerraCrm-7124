import * as React from "react";
import { X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Input } from "../ui/field";
import type { useSwmsLibrary } from "../../queries/swms-lib";

export const GREEN = "#3F7D3A";
export const RUST = "#C0603F";
export const AMBER = "#B7791F";
export const SLATE = "#5B6B7A";

type Data = NonNullable<ReturnType<typeof useSwmsLibrary>["data"]>;
export type Overview = Extract<Data, { ready: true }>;
export type Template = Overview["templates"][number];
export type Block = Overview["blocks"][number];
export type SiteCheck = Overview["siteChecks"][number];
export type Item = Block["items"][number];

export const RISK_COLOUR: Record<string, string> = { H: RUST, M: AMBER, L: GREEN };
export const RISK_LABEL: Record<string, string> = { H: "High", M: "Medium", L: "Low" };

export function RiskPill({ before, after }: { before?: string | null; after?: string | null }) {
  if (!before && !after) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      {before ? <Badge colour={RISK_COLOUR[before]}>{RISK_LABEL[before]}</Badge> : null}
      {after ? (
        <>
          <span aria-hidden>to</span>
          <Badge colour={RISK_COLOUR[after]}>{RISK_LABEL[after]}</Badge>
        </>
      ) : null}
    </span>
  );
}

export function StatusBadge({ t }: { t: Template }) {
  if (t.archived) return <Badge>Archived</Badge>;
  if (t.status === "draft") return <Badge colour={SLATE}>Draft, crew can't see it</Badge>;
  if (t.status === "changed")
    return <Badge colour={AMBER}>Live v{t.latest?.version}, unpublished changes</Badge>;
  return <Badge colour={GREEN}>Live v{t.latest?.version}</Badge>;
}

export const fmtDate = (d: Date | string | null | undefined) =>
  d
    ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Brisbane" }).format(new Date(d))
    : "";

export const fmtDateTime = (d: Date | string) =>
  new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Australia/Brisbane",
  }).format(new Date(d));

export function todayBrisbane() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Brisbane" }).format(new Date());
}

/** A list of short words as removable chips, with a box to add more. Enter or comma adds. */
export function WordList({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  id?: string;
}) {
  const [draft, setDraft] = React.useState("");
  const add = (raw: string) => {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()));
    if (parts.length) onChange([...value, ...parts]);
    setDraft("");
  };
  return (
    <div className="rounded-md border border-input bg-background p-1.5">
      {value.length ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {value.map((w) => (
            <span key={w} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs">
              {w}
              <button type="button" aria-label={`Remove ${w}`} onClick={() => onChange(value.filter((x) => x !== w))}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <Input
        id={id}
        className="h-8 border-0 shadow-none focus-visible:ring-0"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
      />
    </div>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <p className="text-xs text-destructive">{msg}</p>;
}

/** Open a base64 PDF in a new tab. */
export function openPdf(b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
