import { Link } from "wouter";
import { Page } from "../components/layout";
import { Card, Empty, Loading } from "../components/ui/card";
import { JobPrepFacts } from "../components/job-prep";
import { usePrepToFill } from "../queries/prep";
import { dayDate } from "../../api/lib/prep-templates";

/**
 * PREP ANSWERS TO FILL (notes 18.56).
 *
 * Open jobs with an install booked that still need the property type or the
 * furniture answer. Client prep messages wait until both are answered.
 * Answer here and the row drops off.
 */

export default function PrepToFillPage() {
  const q = usePrepToFill();
  const rows = q.data ?? [];

  return (
    <Page
      title="Prep answers to fill"
      subtitle="Open jobs with an install booked that still need the property type or the furniture answer. The client prep messages wait until both are in."
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <p className="text-sm text-destructive">{q.error.message}</p>
      ) : rows.length === 0 ? (
        <Card>
          <Empty>Every job with an install booked has both answers.</Empty>
        </Card>
      ) : (
        <Card>
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <div key={r.jobId} className="flex flex-wrap items-start gap-4 px-4 py-3">
                <div className="min-w-[240px] flex-1">
                  <Link to={`/jobs/${r.jobId}`} className="text-sm font-medium text-primary hover:underline">
                    {r.ref}
                    {r.title ? ` ${r.title}` : ""}
                  </Link>
                  {r.address ? <p className="text-xs text-muted-foreground">{r.address}</p> : null}
                  <p className="text-xs text-muted-foreground">First install day {dayDate(r.firstDay)}</p>
                  <p className="text-xs font-medium text-destructive">Needs {r.missing.join(" and ")}</p>
                </div>
                <div className="w-full sm:w-[300px]">
                  <JobPrepFacts
                    job={{
                      id: r.jobId,
                      furnitureMoving: r.furnitureMoving,
                      site: r.siteId ? { id: r.siteId, propertyType: r.propertyType ?? "" } : null,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </Page>
  );
}
