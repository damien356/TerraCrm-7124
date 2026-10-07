import * as React from "react";
import { FileText, Mail, MapPin, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Card, CardHeader, Empty, Loading } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Checkbox, Select } from "./ui/field";
import { useSetCompanySwms, useSetContactSwms, useSetJobSwms, useSwmsJob } from "../queries/swms";
import { usePinJobTemplate, useSwmsJobTemplates } from "../queries/swms-lib";
import { ClearedFlags, EmailSwmsModal, answerLabel } from "./swms-flags";

const GREEN = "#3F7D3A";
const RUST = "#C0603F";

export function swmsTime(d: Date | string) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(d));
}

export function swmsDay(date: string) {
  return new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

const SOURCE_LABEL: Record<string, string> = {
  job: "set on this job",
  company: "the company needs it",
  contact: "the client needs it",
};

/** The SWMS card on a job: the setting, who's signed, who still has to. */
export function SwmsJobCard({ jobId }: { jobId: number }) {
  const q = useSwmsJob(jobId);
  const set = useSetJobSwms();
  const d = q.data;
  const [emailing, setEmailing] = React.useState<{ recordId: number | null } | null>(null);
  const hasPdf = !!d?.records.some((r) => r.pdfUrl);

  const value = d?.override === null || d?.override === undefined ? "follow" : d.override ? "on" : "off";

  return (
    <Card>
      <CardHeader
        title="SWMS"
        subtitle={
          d
            ? d.required
              ? `Required, ${SOURCE_LABEL[d.source ?? "job"]}. Each worker signs before Start, every day on site.`
              : "Not required on this job."
            : undefined
        }
        action={
          <Select
            aria-label="SWMS on this job"
            className="h-8 w-auto text-xs"
            value={value}
            disabled={!d || set.isPending}
            onChange={(e) => {
              const v = e.target.value;
              set.mutate({ jobId, requiresSwms: v === "follow" ? null : v === "on" });
            }}
          >
            <option value="follow">Follow client</option>
            <option value="on">Required</option>
            <option value="off">Not required</option>
          </Select>
        }
      />
      {q.isLoading ? (
        <Loading />
      ) : !d ? (
        <Empty>Couldn't load the SWMS.</Empty>
      ) : (
        <div>
          {d.outstanding.length > 0 ? (
            <div className="flex items-start gap-2 border-b border-border bg-[#C0603F14] px-4 py-2.5 text-xs">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" style={{ color: RUST }} />
              <span>
                <span className="font-medium" style={{ color: RUST }}>
                  Outstanding:
                </span>{" "}
                {d.outstanding.map((o) => `${o.installerName} (${swmsDay(o.date)})`).join(", ")}
              </span>
            </div>
          ) : null}
          {d.required ? <JobTemplates jobId={jobId} /> : null}
          {d.records.length === 0 ? (
            <Empty>{d.required ? "Nobody has signed one yet." : "No SWMS signed on this job."}</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {d.records.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <ShieldCheck className="size-3.5" style={{ color: GREEN }} />
                      {r.installerName}
                      <span className="font-normal text-muted-foreground">
                        {swmsDay(r.workDate)}, {swmsTime(r.signedAt)}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {r.kind === "reconfirm" ? "Daily re-confirm" : "Full review"}, signed as {r.signedName}
                      {r.customHazard ? `. Added: ${r.customHazard}` : ""}
                    </p>
                    {r.siteAnswers.length > 0 ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Site checks:{" "}
                        {r.siteAnswers.map((a, i) => (
                          <span key={a.checkId} style={a.flagged ? { color: RUST, fontWeight: 600 } : undefined}>
                            {i ? "; " : ""}
                            {a.question} {answerLabel(a.answer)}
                          </span>
                        ))}
                      </p>
                    ) : null}
                    {r.gps ? (
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <MapPin className="size-3" />
                        {r.gps.status === "ok" && r.gps.lat !== null && r.gps.lng !== null ? (
                          <a
                            className="text-primary hover:underline"
                            href={`https://maps.google.com/?q=${r.gps.lat},${r.gps.lng}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Signed here{r.gps.accuracy ? ` (within ${Math.round(r.gps.accuracy)} m)` : ""}
                          </a>
                        ) : r.gps.status === "not_sent" ? (
                          "Older app, no location"
                        ) : (
                          "Location not shared"
                        )}
                      </p>
                    ) : null}
                    {r.sds.length > 0 ? (
                      <p className="mt-1 flex flex-wrap gap-1">
                        {r.sds.map((s) => (
                          <a key={s.id} href={s.url} target="_blank" rel="noreferrer">
                            <Badge>SDS {s.product}</Badge>
                          </a>
                        ))}
                      </p>
                    ) : null}
                  </div>
                  {r.pdfUrl ? (
                    <span className="flex items-center gap-3">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      onClick={() => setEmailing({ recordId: r.id })}
                    >
                      <Mail className="size-3.5" /> Email
                    </button>
                    <a
                      href={r.pdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      <FileText className="size-3.5" /> PDF
                    </a>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {hasPdf ? (
            <div className="flex justify-end border-t border-border px-4 py-2.5">
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setEmailing({ recordId: null })}>
                <Mail className="size-3.5" /> Email SWMS
              </Button>
            </div>
          ) : null}
          <ClearedFlags flags={d.flags} />
          <EmailLog emails={d.emails} />
        </div>
      )}
      {emailing && d ? (
        <EmailSwmsModal jobId={jobId} records={d.records} recordId={emailing.recordId} onClose={() => setEmailing(null)} />
      ) : null}
    </Card>
  );
}

type SwmsEmail = NonNullable<ReturnType<typeof useSwmsJob>["data"]>["emails"][number];

/** Every SWMS email sent from this job, newest first. */
function EmailLog({ emails }: { emails: SwmsEmail[] }) {
  if (!emails.length) return null;
  return (
    <div className="border-t border-border px-4 py-2.5 text-xs">
      <p className="mb-1 font-medium text-muted-foreground">Emailed</p>
      <ul className="grid gap-0.5">
        {emails.map((e) => (
          <li key={e.id}>
            {e.ok ? "Sent to" : "Failed to"} {e.toEmail}, by {e.sentByName},{" "}
            {new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short" }).format(new Date(e.sentAt))}{" "}
            {swmsTime(e.sentAt)}
            {e.error ? <span className="text-destructive"> ({e.error})</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Which SWMS templates the crew gets on this job: the ones picked from the
 * labour, plus any Office added by hand. Takes effect on the next signature.
 */
function JobTemplates({ jobId }: { jobId: number }) {
  const q = useSwmsJobTemplates(jobId);
  const pin = usePinJobTemplate();
  const d = q.data;
  if (!d || !d.ready) return null;
  const title = (k: string) => d.options.find((o) => o.key === k)?.title ?? k;
  const extra = d.all.filter((k) => !d.fromLabour.includes(k) && !d.pinned.includes(k));
  const addable = d.options.filter((o) => !d.all.includes(o.key));
  return (
    <div className="border-b border-border px-4 py-2.5 text-xs">
      <p className="mb-1.5 text-muted-foreground">Crew signs these sections. Changes apply from the next signature.</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {d.fromLabour.map((k) => (
          <span key={k} title="Picked from the labour on this job">
            <Badge>{title(k)}</Badge>
          </span>
        ))}
        {d.pinned
          .filter((k) => !d.fromLabour.includes(k))
          .map((k) => (
            <span key={k} className="inline-flex items-center gap-1 rounded-full border border-primary px-2 py-0.5 text-[11px] text-primary">
              {title(k)}, added
              <button
                type="button"
                aria-label={`Take ${title(k)} off this job`}
                disabled={pin.isPending}
                onClick={() => pin.mutate({ jobId, templateKey: k, pinned: false })}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        {extra.map((k) => (
          <span key={k} title="Brought in by another section">
            <Badge>{title(k)}</Badge>
          </span>
        ))}
        {d.all.length === 0 ? <span className="text-muted-foreground">Nothing picked from the labour yet.</span> : null}
        {addable.length ? (
          <Select
            aria-label="Add a SWMS section"
            className="h-7 w-auto text-xs"
            value=""
            disabled={pin.isPending}
            onChange={(e) => e.target.value && pin.mutate({ jobId, templateKey: e.target.value, pinned: true })}
          >
            <option value="">Add a section</option>
            {addable.map((o) => (
              <option key={o.key} value={o.key}>
                {o.title}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
    </div>
  );
}

/** "Requires SWMS" on a client or company record. */
export function SwmsToggle({
  kind,
  id,
  value,
}: {
  kind: "contact" | "company";
  id: number;
  value: boolean;
}) {
  const setContact = useSetContactSwms();
  const setCompany = useSetCompanySwms();
  const pending = setContact.isPending || setCompany.isPending;
  const htmlId = `swms_toggle_${kind}_${id}`;
  return (
    <label htmlFor={htmlId} className="flex items-start gap-2 text-sm">
      <Checkbox
        id={htmlId}
        checked={value}
        disabled={pending}
        onChange={(e) =>
          kind === "contact"
            ? setContact.mutate({ contactId: id, requiresSwms: e.target.checked })
            : setCompany.mutate({ companyId: id, requiresSwms: e.target.checked })
        }
      />
      <span>
        <span className="font-medium">Requires SWMS</span>
        <span className="block text-xs text-muted-foreground">
          Every job for this {kind === "contact" ? "client" : "company"} asks the crew for a signed SWMS before they start.
          Change it per job on the job page.
        </span>
      </span>
    </label>
  );
}
