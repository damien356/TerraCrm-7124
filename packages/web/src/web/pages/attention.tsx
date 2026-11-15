import * as React from "react";
import { Link, useSearch } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Modal } from "../components/ui/modal";
import { Label, Textarea } from "../components/ui/field";
import { useAttention, useQuoteNeeded } from "../queries/attention";
import { auDay, cn } from "../lib/utils";

/* ---------------------------------------------------------------------------
 * Needs attention (Damien, 14 Nov 2026). What the Terra Today widget opens.
 *
 * Built by the same server call as the widget's counts, for the same login,
 * so each count is exactly the rows under it. Every line counts jobs, each
 * job once, and the total at the top is distinct jobs, never the lines added
 * up. ?show=<key> opens one list. Informational: nothing here sends to a
 * customer, books anyone or sends a quote. The one thing the office can
 * record here is "No quote needed" on a measure, with a reason.
 * ------------------------------------------------------------------------- */

const SUBTITLE: Record<string, string> = {
  enquiries: "Lead or Quoted, with a first call, office task or callback due now. The date is when it came in.",
  quotes: "Measure or site visit marked completed, quote not sent to the customer yet. Overdue after 24 hours. The date is when it was done.",
  unfilled: "Dispatches in the next week or not dated, with nobody on them",
  offers: "Offer sent to an installer, waiting for an answer",
  overdue: "Final working day has passed, still not finished",
  incomplete: "Booked, but the working days are not set",
};

const TONE: Record<string, string> = {
  warning: "bg-amber-100 text-amber-900 border-amber-300",
  danger: "bg-red-100 text-red-800 border-red-300",
};

type Row = NonNullable<ReturnType<typeof useAttention>["data"]>["sections"][number]["rows"][number];

export default function AttentionPage() {
  const q = useAttention();
  const show = new URLSearchParams(useSearch()).get("show");
  const [asking, setAsking] = React.useState<Row | null>(null);
  const [recorded, setRecorded] = React.useState<{ jobId: number; ref: string } | null>(null);
  const qn = useQuoteNeeded();

  if (q.isLoading) return <Loading label="Loading…" />;
  if (q.isError) {
    return (
      <Page title="Needs attention">
        <Card>
          <Empty>Couldn't load the list. {String(q.error)}</Empty>
        </Card>
      </Page>
    );
  }

  const sections = q.data!.sections;
  const picked = sections.find((s) => s.key === show);
  const visible = picked ? [picked] : sections;
  const total = new Set(sections.flatMap((s) => s.rows.map((r) => r.key))).size;
  const offerCount = (sections.find((s) => s.key === "offers")?.rows ?? []).reduce((n, r) => n + (r.pendingOffers ?? 0), 0);

  return (
    <Page title="Needs attention" subtitle={`${total} ${total === 1 ? "job" : "jobs"} in total, each counted once even when it is on more than one list`}>
      <div className="mb-3 flex flex-wrap gap-2">
        <Link
          to="/attention"
          className={cn("rounded-full border px-3 py-1.5 text-sm font-medium", !picked ? "border-primary bg-primary text-white" : "border-border hover:bg-secondary/60")}
        >
          All
        </Link>
        {sections.map((s) => (
          <Link
            key={s.key}
            to={`/attention?show=${s.key}`}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-medium",
              picked?.key === s.key ? "border-primary bg-primary text-white" : "border-border hover:bg-secondary/60",
            )}
          >
            {s.label} ({s.rows.length})
          </Link>
        ))}
      </div>

      {recorded ? (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-secondary/50 px-4 py-2.5 text-sm">
          <span>
            Recorded: no quote needed on job {recorded.ref}. It is noted on the job's activity.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={qn.neededAgain.isPending}
            onClick={() => qn.neededAgain.mutate({ jobId: recorded.jobId, reason: "Undone on Needs attention" }, { onSuccess: () => setRecorded(null) })}
          >
            Undo
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4">
        {visible.map((s) => (
          <Card key={s.key}>
            <CardHeader
              title={`${s.label} (${s.rows.length})`}
              subtitle={
                s.key === "offers" && s.rows.length
                  ? `${SUBTITLE.offers}. Pending installer offers: ${offerCount}, on ${s.rows.length} ${s.rows.length === 1 ? "job" : "jobs"}.`
                  : SUBTITLE[s.key]
              }
            />
            {s.rows.length === 0 ? (
              <Empty>Nothing here.</Empty>
            ) : (
              <div className="divide-y divide-border">
                {s.rows.map((r) => (
                  <div key={`${s.key}-${r.key}`} className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-secondary/60 sm:flex-row sm:items-start">
                    <Link to={r.path} className="block min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{r.title}</p>
                        {r.badge ? (
                          <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", TONE[r.badge.tone])}>{r.badge.label}</span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {[r.ref, r.suburb, r.date ? auDay(r.date) : "Not dated"].filter(Boolean).join(" · ")}
                      </p>
                      {r.note ? <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">{r.note}</p> : null}
                    </Link>
                    {s.key === "quotes" && r.jobId ? (
                      <Button size="sm" variant="outline" className="self-start" onClick={() => setAsking(r)}>
                        No quote needed
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>

      {asking ? (
        <NoQuoteModal
          row={asking}
          busy={qn.notNeeded.isPending}
          error={qn.notNeeded.error ? (qn.notNeeded.error instanceof Error ? qn.notNeeded.error.message : String(qn.notNeeded.error)) : null}
          onClose={() => {
            qn.notNeeded.reset();
            setAsking(null);
          }}
          onSave={(reason) =>
            qn.notNeeded.mutate(
              { jobId: asking.jobId!, reason },
              {
                onSuccess: () => {
                  setRecorded({ jobId: asking.jobId!, ref: asking.ref });
                  setAsking(null);
                },
              },
            )
          }
        />
      ) : null}
    </Page>
  );
}

function NoQuoteModal({ row, busy, error, onClose, onSave }: { row: Row; busy: boolean; error: string | null; onClose: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = React.useState("");
  const ok = reason.trim().length >= 3;
  return (
    <Modal
      open
      onClose={onClose}
      title={`No quote needed on job ${row.ref}?`}
      subtitle="It comes off Measures awaiting a quote. Nothing is sent to the customer."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok || busy} onClick={() => onSave(reason.trim())}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <Label htmlFor="no-quote-why">Why is no quote needed?</Label>
      <Textarea
        id="no-quote-why"
        className="mt-1.5"
        rows={3}
        value={reason}
        placeholder="For example: the customer went with someone else, or it is warranty work"
        onChange={(e) => setReason(e.target.value)}
      />
      {error ? <p className="mt-2 text-sm font-medium text-red-700">{error}</p> : null}
    </Modal>
  );
}
