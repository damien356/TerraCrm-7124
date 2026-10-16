import { Link } from "wouter";
import { Card, CardHeader, Empty, Loading, Stat } from "./ui/card";
import { Badge } from "./ui/badge";
import { money } from "../lib/money";
import { useReferralReport } from "../queries/referrals";

/**
 * The Admin only "Referral fees" tab on Referrers (notes 18.47). For each
 * referrer ticked on a company or client card: jobs referred, their value,
 * and the fees owed and paid. Fees are ex GST. The dates are on the job.
 */
export function ReferralFeesTab({ range }: { range: { from: string | null; to: string | null } }) {
  const q = useReferralReport(range);
  const d = q.data;

  return (
    <>
      <div className="mb-3 grid gap-3 sm:grid-cols-4">
        <Stat label="Jobs referred" value={d ? d.totals.jobs : "…"} hint="Jobs with a referrer picked, in this period" />
        <Stat label="Value referred" value={d ? money(d.totals.value) : "…"} hint="Cancelled jobs left out" />
        <Stat label="Fees owed" value={d ? money(d.totals.owed) : "…"} tone={d && d.totals.owed > 0 ? "warning" : "default"} hint="Ex GST. Pay them from Finance, Referrers owed" />
        <Stat label="Fees paid" value={d ? money(d.totals.paid) : "…"} hint="Ex GST" />
      </div>

      {q.isLoading || !d ? (
        <Card>
          <Loading label="Adding up referral fees…" />
        </Card>
      ) : d.rows.length === 0 ? (
        <Card>
          <Empty>Nobody is ticked as a referrer yet. Tick "Also a referrer" on a company or client card.</Empty>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Referral fees"
            subtitle="Admin only. Fees are ex GST, on top of the price."
            action={
              <Link to="/finance/referrers-owed" className="text-xs font-medium text-primary hover:underline">
                Referrers owed
              </Link>
            }
          />
          <div className="board-scroll overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="th px-4">Referrer</th>
                  <th className="th px-4 text-right">Rate</th>
                  <th className="th px-4 text-right">Jobs</th>
                  <th className="th px-4 text-right">Value referred</th>
                  <th className="th px-4 text-right">Owed</th>
                  <th className="th px-4 text-right">Paid</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                    <td className="px-4 py-2.5">
                      <Link to={r.companyId != null ? `/companies/${r.companyId}` : `/clients/${r.contactId}`} className="font-medium text-primary hover:underline">
                        {r.name}
                      </Link>
                      {!r.active ? (
                        <Badge className="ml-2" colour="#7A736D">
                          Not ticked now
                        </Badge>
                      ) : null}
                      {r.flagged ? (
                        <Badge className="ml-2" colour="#D08A1E">
                          {r.flagged} to decide
                        </Badge>
                      ) : null}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right text-muted-foreground">{r.rate}</td>
                    <td className="tabular px-4 py-2.5 text-right">{r.jobs}</td>
                    <td className="tabular px-4 py-2.5 text-right">{money(r.value)}</td>
                    <td className="tabular px-4 py-2.5 text-right font-semibold">{r.owed ? money(r.owed) : "-"}</td>
                    <td className="tabular px-4 py-2.5 text-right">{r.paid ? money(r.paid) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
