import { FileText, ShieldAlert, ShieldCheck } from "lucide-react";
import { Card, CardHeader, Empty, Loading } from "./ui/card";
import { Badge } from "./ui/badge";
import { Checkbox, Select } from "./ui/field";
import { useSetCompanySwms, useSetContactSwms, useSetJobSwms, useSwmsJob } from "../queries/swms";

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
                    <a
                      href={r.pdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      <FileText className="size-3.5" /> PDF
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
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
