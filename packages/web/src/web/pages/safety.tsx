import * as React from "react";
import { Link } from "wouter";
import { FileText, ShieldAlert, ShieldCheck, Upload } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input, Select } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { swmsDay, swmsTime } from "../components/swms";
import { useArchiveSds, useSafetyDocs, useSaveSds, useSdsUploadUrl, useSwmsBoard } from "../queries/swms";

const GREEN = "#3F7D3A";
const RUST = "#C0603F";
const AMBER = "#B7791F";

/**
 * Safety: the SWMS board (who has signed for which job, which day) and the
 * SDS library the SWMS attaches from.
 */
export default function SafetyPage() {
  const [tab, setTab] = React.useState<"board" | "sds">("board");
  return (
    <Page
      title="SWMS and SDS"
      subtitle="Signed SWMS per worker per day on every job that needs one, and the safety data sheets they attach."
      actions={
        <div className="flex gap-1 rounded-md bg-secondary p-1">
          {(
            [
              ["board", "SWMS board"],
              ["sds", "SDS library"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`rounded px-3 py-1 text-xs font-medium ${tab === k ? "bg-background shadow-xs" : "text-muted-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      {tab === "board" ? <Board /> : <Library />}
    </Page>
  );
}

function Board() {
  const q = useSwmsBoard({});
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Empty>Couldn't load the board.</Empty>;
  const { rows, today } = q.data;
  const todays = rows.filter((r) => r.date === today);
  const overdue = rows.filter((r) => r.date < today && !r.record);
  const byDate = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push(r);
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Signed today" value={todays.filter((r) => r.record).length} />
        <Stat
            label="Outstanding today"
            value={todays.filter((r) => !r.record).length}
            tone={todays.some((r) => !r.record) ? "warning" : "default"}
          />
        <Stat label="Missed, last 7 days" value={overdue.length} tone={overdue.length ? "warning" : "default"} />
      </div>

      {rows.length === 0 ? (
        <Card>
          <Empty>
            No crew booked on a SWMS job in the last week or the next fortnight. Turn SWMS on from a client, company or job.
          </Empty>
        </Card>
      ) : (
        [...byDate.entries()].map(([date, list]) => (
          <Card key={date}>
            <CardHeader
              title={`${swmsDay(date)}${date === today ? ", today" : ""}`}
              subtitle={`${list.filter((r) => r.record).length} of ${list.length} signed`}
            />
            <ul className="divide-y divide-border">
              {list.map((r) => {
                const future = r.date > today;
                return (
                  <li key={`${r.jobId}-${r.installerId}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm">
                        <Link to={`/jobs/${r.jobId}`} className="font-medium text-primary hover:underline">
                          Job {r.jobNumber}
                        </Link>{" "}
                        <span className="text-muted-foreground">{r.siteAddress || r.jobTitle}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {r.installerName} · {r.taskTitles.join(", ")}
                      </p>
                    </div>
                    {r.record ? (
                      <Badge colour={GREEN}>
                        <ShieldCheck className="size-3" /> Signed {swmsTime(r.record.signedAt)}
                        {r.record.kind === "reconfirm" ? ", re-confirm" : ""}
                      </Badge>
                    ) : future ? (
                      <Badge>Due on the day</Badge>
                    ) : (
                      <Badge colour={RUST}>
                        <ShieldAlert className="size-3" /> Outstanding
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}

function Library() {
  const q = useSafetyDocs();
  const archive = useArchiveSds();
  const [upload, setUpload] = React.useState<string | null>(null);
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Empty>Couldn't load the library.</Empty>;

  return (
    <Card>
      <CardHeader
        title="Safety data sheets"
        subtitle="The current SDS for each product is attached to every SWMS that ticks it. Upload a newer one and the old one is kept for past records."
      />
      <ul className="divide-y divide-border">
        {q.data.catalogue.filter((c) => !c.archived || c.current).map((c) => {
          const cur = c.current;
          const pds = c.others.filter((o) => o.kind === "pds");
          return (
            <li key={c.code} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{c.product}</p>
                {cur ? (
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <a href={cur.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      <FileText className="size-3.5" /> {cur.filename || "SDS"}
                    </a>
                    {cur.revision ? <span>{cur.revision}</span> : null}
                    {cur.issuedOn ? <span>issued {cur.issuedOn}</span> : null}
                    {cur.reviewDue ? (
                      c.expired ? (
                        <Badge colour={RUST}>Review was due {cur.reviewDue}, get the new sheet</Badge>
                      ) : (
                        <span>review by {cur.reviewDue}</span>
                      )
                    ) : null}
                    {cur.region !== "AU" ? <Badge colour={AMBER}>{cur.region} sheet, need the AU one</Badge> : null}
                    {cur.notes ? <span>{cur.notes}</span> : null}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs" style={{ color: RUST }}>
                    No SDS on file. SWMS that use it say "SDS not on file yet".
                  </p>
                )}
                {pds.map((p) => (
                  <p key={p.id} className="mt-0.5 text-xs text-muted-foreground">
                    <a href={p.url} target="_blank" rel="noreferrer" className="hover:underline">
                      Product data sheet on file
                    </a>
                    , not an SDS, so it isn't attached.
                  </p>
                ))}
              </div>
              <div className="flex gap-2">
                {cur ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={archive.isPending}
                    onClick={() => {
                      if (confirm(`Retire the current SDS for ${c.product}? Past SWMS keep their link.`)) archive.mutate({ id: cur.id });
                    }}
                  >
                    Retire
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => setUpload(c.code)}>
                  <Upload className="size-3.5" /> {cur ? "Replace" : "Upload"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {upload ? (
        <UploadModal
          code={upload}
          product={q.data.catalogue.find((c) => c.code === upload)?.product ?? ""}
          onClose={() => setUpload(null)}
        />
      ) : null}
    </Card>
  );
}

function UploadModal({ code, product, onClose }: { code: string; product: string; onClose: () => void }) {
  const presign = useSdsUploadUrl();
  const save = useSaveSds();
  const [file, setFile] = React.useState<File | null>(null);
  const [revision, setRevision] = React.useState("");
  const [issuedOn, setIssuedOn] = React.useState("");
  const [reviewOn, setReviewOn] = React.useState("");
  const [reviewTouched, setReviewTouched] = React.useState(false);
  const fiveYears = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(0, 4)) + 5}${d.slice(4)}` : "");
  const [region, setRegion] = React.useState<"AU" | "NZ">("AU");
  const [kind, setKind] = React.useState<"sds" | "pds">("sds");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function go() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { url, key } = await presign.mutateAsync({ filename: file.name, contentType: file.type || "application/pdf" });
      const put = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/pdf" } });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      await save.mutateAsync({
        code,
        kind,
        revision,
        issuedOn: issuedOn || null,
        reviewOn: reviewOn || null,
        region,
        storageKey: key,
        filename: file.name,
        sizeBytes: file.size,
        notes: "",
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Upload for ${product}`}>
      <div className="grid gap-3">
        <Field label="PDF">
          <Input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value as "sds" | "pds")}>
              <option value="sds">Safety data sheet</option>
              <option value="pds">Product data sheet (kept, not attached)</option>
            </Select>
          </Field>
          <Field label="Country">
            <Select value={region} onChange={(e) => setRegion(e.target.value as "AU" | "NZ")}>
              <option value="AU">Australia</option>
              <option value="NZ">New Zealand</option>
            </Select>
          </Field>
          <Field label="Revision">
            <Input value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="Revision 8" />
          </Field>
          <Field label="Issued">
            <Input
              type="date"
              value={issuedOn}
              onChange={(e) => {
                setIssuedOn(e.target.value);
                if (!reviewTouched) setReviewOn(fiveYears(e.target.value));
              }}
            />
          </Field>
          <Field label="Review by" hint="Five years after issue unless the sheet says sooner.">
            <Input
              type="date"
              value={reviewOn}
              onChange={(e) => {
                setReviewTouched(true);
                setReviewOn(e.target.value);
              }}
            />
          </Field>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!file || busy} onClick={go}>
            {busy ? "Uploading" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
