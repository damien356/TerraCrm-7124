import * as React from "react";
import { Link } from "wouter";
import { Plus, Search, Sofa, UserX } from "lucide-react";
import { Page } from "../components/layout";
import { MemoButton } from "../components/voice-memo";
import { Card, Empty, Loading } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input, Select } from "../components/ui/field";
import { NewJobModal } from "../components/new-job-modal";
import { useJobs } from "../queries/jobs";
import { useBootstrap } from "../queries/settings";

const money = (n: number) =>
  n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

export default function JobsPage() {
  const [search, setSearch] = React.useState("");
  const [statusId, setStatusId] = React.useState("");
  const [modal, setModal] = React.useState(false);
  const bootstrap = useBootstrap();
  const jobs = useJobs({
    search: search || undefined,
    statusId: statusId ? Number(statusId) : undefined,
  });

  return (
    <Page
      title="Jobs"
      subtitle="Every job is a set of dispatches — tile removal, prep, lay, skirting, silicone."
      actions={
        <Button onClick={() => setModal(true)}>
          <Plus className="size-4" />
          New job
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Job number, address, customer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select className="w-auto min-w-[160px]" value={statusId} onChange={(e) => setStatusId(e.target.value)}>
          <option value="">All statuses</option>
          {(bootstrap.data?.statuses ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        {jobs.isLoading ? (
          <Loading />
        ) : (jobs.data ?? []).length === 0 ? (
          <Empty>No jobs match that.</Empty>
        ) : (
          <div className="board-scroll overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="th px-4">Job</th>
                  <th className="th px-4">Customer</th>
                  <th className="th px-4">Site</th>
                  <th className="th px-4">Status</th>
                  <th className="th px-4 text-right">Dispatches</th>
                  <th className="th px-4 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {(jobs.data ?? []).map((j) => (
                  <tr key={j.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1">
                        <Link to={`/jobs/${j.id}`} className="font-medium text-primary hover:underline">
                          #{j.displayNumber ?? j.number}
                        </Link>
                        <MemoButton jobId={j.id} compact />
                      </span>
                      <p className="max-w-[240px] truncate text-xs text-muted-foreground">{j.title || "Untitled"}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="truncate">
                        {j.company?.name ??
                          [j.contact?.firstName, j.contact?.lastName].filter(Boolean).join(" ") ??
                          "—"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        bills {j.billToType === "company" ? "the company" : "the contact"}
                      </p>
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="max-w-[220px] truncate">{j.site?.address ?? "—"}</p>
                      <p className="text-xs text-muted-foreground">{j.site?.suburb ?? ""}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge colour={j.status?.colour}>{j.status?.name ?? "No status"}</Badge>
                        {j.supervisorMissing ? (
                          <Badge colour="#B7791F">
                            <UserX className="size-3" />
                            Supervisor missing
                          </Badge>
                        ) : null}
                        {j.furnitureOnSite ? (
                          <Badge colour="#C0603F">
                            <Sofa className="size-3" />
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {j.doneCount}/{j.taskCount}
                      {j.unassignedCount > 0 ? (
                        <span className="ml-1 text-xs text-[var(--warning)]">{j.unassignedCount} open</span>
                      ) : null}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right font-medium">{money(j.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <NewJobModal open={modal} onClose={() => setModal(false)} />
    </Page>
  );
}
