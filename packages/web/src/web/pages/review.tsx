import * as React from "react";
import { Link } from "wouter";
import { Ban, Building2, Check, RotateCcw, Search, Trash2, User } from "lucide-react";
import { Page } from "../components/layout";
import { Card, Empty, Loading, Spinner, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { useResolveReview, useReviewQueue, useReviewStats } from "../queries/review";

type Decision = "homeowner" | "business" | "block" | "archive" | "reopen";

const COMPANY_TYPES = ["builder", "agency", "commercial", "strata", "retail", "other"] as const;

const DECISION_LABEL: Record<string, string> = {
  homeowner: "Called a homeowner",
  business: "Called a business",
  block: "No marketing",
  archive: "Not a client",
  reopen: "Back in the queue",
};

const money = (n: number) =>
  n >= 1000 ? `$${Math.round(n / 1000)}k` : n > 0 ? `$${Math.round(n)}` : "—";

/** ServiceM8 clients can carry dozens of sites. Show enough to recognise them. */
function suburbList(raw: string) {
  const parts = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!parts.length) return "";
  return parts.length > 3 ? `${parts.slice(0, 3).join(", ")} +${parts.length - 3} more` : parts.join(", ");
}

const shortDate = (d: string | Date | null) =>
  d ? new Date(d).toLocaleDateString("en-AU", { month: "short", year: "numeric" }) : "—";

/** The extra question a business or a block needs before it can be recorded. */
function DecisionModal({
  decision,
  count,
  personName,
  suggestedCompany,
  onClose,
  onConfirm,
  pending,
}: {
  decision: Exclude<Decision, "homeowner" | "reopen"> | null;
  count: number;
  /** The person on the record, when it is a single one. */
  personName: string;
  /** The ServiceM8 client name, which is what the company gets called. */
  suggestedCompany: string;
  onClose: () => void;
  onConfirm: (extra: {
    reason?: string;
    companyType?: (typeof COMPANY_TYPES)[number];
    companyName?: string;
  }) => void;
  pending: boolean;
}) {
  const [reason, setReason] = React.useState("");
  const [companyType, setCompanyType] = React.useState<(typeof COMPANY_TYPES)[number]>("builder");
  const [companyName, setCompanyName] = React.useState("");

  React.useEffect(() => {
    if (decision) {
      setReason("");
      setCompanyType("builder");
      setCompanyName(suggestedCompany);
    }
  }, [decision, suggestedCompany]);

  if (!decision) return null;

  const copy = {
    business: {
      title: count > 1 ? `Mark ${count} records as a business` : "Mark as a business",
      subtitle:
        count > 1
          ? "One company is created, every person selected is linked to it as a contact, and their jobs and sites move across. Businesses never get marketing."
          : "The ServiceM8 name becomes the company. The person stays their own record, linked to it as the contact, and their jobs and sites move across. Businesses never get marketing.",
    },
    block: {
      title: count > 1 ? `Block ${count} records from marketing` : "Block from marketing",
      subtitle: "Keeps the history and the job file. Nothing can ever enrol them, not even a hand written blast.",
    },
    archive: {
      title: count > 1 ? `Archive ${count} records` : "Archive this record",
      subtitle: "Not a client at all. History stays, the record drops out of every list and every campaign.",
    },
  }[decision];

  return (
    <Modal
      open
      onClose={onClose}
      title={copy.title}
      subtitle={copy.subtitle}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={decision === "homeowner" ? "default" : decision === "business" ? "default" : "destructive"}
            disabled={pending}
            onClick={() =>
              onConfirm(
                decision === "business"
                  ? { companyType, companyName: companyName.trim() || undefined }
                  : { reason },
              )
            }
          >
            {pending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Confirm
          </Button>
        </>
      }
    >
      {decision === "business" ? (
        <div className="grid gap-3">
          {count === 1 ? (
            <>
              <Field label="Company name" hint="Comes from the ServiceM8 client name. Fix it here if it is messy.">
                <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
              </Field>
              <p className="text-xs text-muted-foreground">
                {personName || "This person"} stays a client in their own right, linked to{" "}
                {companyName.trim() || "the company"} as the contact.
              </p>
            </>
          ) : null}
          <Field label="What kind of business">
          <Select value={companyType} onChange={(e) => setCompanyType(e.target.value as (typeof COMPANY_TYPES)[number])}>
              {COMPANY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : (
        <Field label="Reason (optional, saved on the record)">
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={decision === "block" ? "Went into liquidation, asked off the list…" : "Supplier, test record…"}
          />
        </Field>
      )}
    </Modal>
  );
}

export default function ReviewPage() {
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<"jobs" | "recent" | "name">("jobs");
  const [resolved, setResolved] = React.useState(false);
  const [selected, setSelected] = React.useState<number[]>([]);
  const [modal, setModal] = React.useState<{ decision: Exclude<Decision, "homeowner" | "reopen">; ids: number[] } | null>(
    null,
  );

  const stats = useReviewStats();
  const queue = useReviewQueue({ search: search || undefined, resolved, sort, limit: 200 });
  const resolve = useResolveReview();
  const rows = queue.data ?? [];

  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function run(
    decision: Decision,
    ids: number[],
    extra: { reason?: string; companyType?: string; companyName?: string } = {},
  ) {
    if (!ids.length) return;
    await resolve.mutateAsync({ ids, decision, ...extra } as never);
    setSelected((s) => s.filter((id) => !ids.includes(id)));
    setModal(null);
  }

  const bulk = selected.length > 0;
  /** The one record a single-record modal is about, so it can name the company. */
  const modalRow = modal?.ids.length === 1 ? rows.find((r) => r.id === modal.ids[0]) : undefined;

  return (
    <Page
      title="Import review"
      subtitle="ServiceM8 sent these across with no client type on them. Nothing here can be marketed to until you say what it is."
      wide
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Waiting on you"
          value={stats.data?.contactsAwaiting ?? "—"}
          tone={(stats.data?.contactsAwaiting ?? 0) > 0 ? "warning" : "success"}
          hint="Records with no client type"
        />
        <Stat
          label="Marketable now"
          value={stats.data?.marketable ?? "—"}
          tone="success"
          hint="Homeowners with a job finished since 2023"
        />
        <Stat
          label="Blocked"
          value={(stats.data?.blockedContacts ?? 0) + (stats.data?.blockedCompanies ?? 0)}
          hint="Hard no, outranks everything"
        />
        <Stat
          label="Imported"
          value={stats.data ? stats.data.importedJobs.toLocaleString() : "—"}
          hint={
            stats.data
              ? `${stats.data.importedJobs.toLocaleString()} jobs, ${stats.data.importedContacts.toLocaleString()} people, ${stats.data.importedCompanies} companies`
              : "From ServiceM8"
          }
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1 max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Name, ServiceM8 name, email, mobile, suburb…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select className="w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="jobs">Most jobs first</option>
          <option value="recent">Most recent job first</option>
          <option value="name">Name</option>
        </Select>
        <Button variant={resolved ? "default" : "outline"} size="sm" onClick={() => { setResolved(!resolved); setSelected([]); }}>
          {resolved ? "Showing sorted" : "Show already sorted"}
        </Button>
      </div>

      {bulk ? (
        <Card className="mb-3 flex flex-wrap items-center gap-2 px-4 py-3">
          <p className="mr-auto text-sm font-medium">{selected.length} selected</p>
          {resolved ? (
            <Button size="sm" variant="outline" onClick={() => run("reopen", selected)}>
              <RotateCcw className="size-4" />
              Put back in the queue
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={() => run("homeowner", selected)}>
                <User className="size-4" />
                Homeowner
              </Button>
              <Button size="sm" variant="outline" onClick={() => setModal({ decision: "business", ids: selected })}>
                <Building2 className="size-4" />
                Business
              </Button>
              <Button size="sm" variant="outline" onClick={() => setModal({ decision: "block", ids: selected })}>
                <Ban className="size-4" />
                No marketing
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setModal({ decision: "archive", ids: selected })}>
                <Trash2 className="size-4" />
                Not a client
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear
          </Button>
        </Card>
      ) : null}

      <Card>
        {queue.isLoading ? (
          <Loading label="Loading the queue…" />
        ) : rows.length === 0 ? (
          <Empty>
            {resolved
              ? "Nothing sorted yet."
              : search
                ? "No records match that."
                : "Queue is clear. Every imported record has a client type."}
          </Empty>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => {
              const name = `${r.firstName} ${r.lastName}`.trim();
              const checked = selected.includes(r.id);
              return (
                <div key={r.id} className={checked ? "bg-secondary/60 px-4 py-3" : "px-4 py-3 hover:bg-secondary/40"}>
                  <div className="flex flex-wrap items-start gap-3">
                    <label className="mt-1" htmlFor={`rev_${r.id}`}>
                      <Checkbox id={`rev_${r.id}`} checked={checked} onChange={() => toggle(r.id)} />
                    </label>

                    <div className="min-w-[220px] flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={`/clients/${r.id}`} className="font-medium text-primary hover:underline">
                          {name || r.externalRef || `Record ${r.id}`}
                        </Link>
                        {r.externalRef && r.externalRef.toLowerCase() !== name.toLowerCase() ? (
                          <Badge title="The ServiceM8 client name. Press Business and this becomes the company.">
                            Company: {r.externalRef}
                          </Badge>
                        ) : null}
                        {r.doNotMarket ? <Badge colour="#C0603F">No marketing</Badge> : null}
                        {!r.active ? <Badge>Archived</Badge> : null}
                        {r.marketingBasis !== "none" ? <Badge colour="#3F7D3A">Marketable</Badge> : null}
                        {resolved && r.lastDecision ? (
                          <Badge colour="#4A7FA5">{DECISION_LABEL[r.lastDecision] ?? r.lastDecision}</Badge>
                        ) : null}
                        {r.companyNames ? <Badge colour="#4A7FA5">{r.companyNames}</Badge> : null}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {[r.email, r.mobile, suburbList(r.suburbs) || r.suburb].filter(Boolean).join("  ·  ") ||
                          "No contact detail"}
                      </p>
                      {r.lastJobTitle ? (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">Last job: {r.lastJobTitle}</p>
                      ) : null}
                    </div>

                    <div className="tabular flex shrink-0 gap-5 text-xs">
                      <div>
                        <p className="label-xs">Jobs</p>
                        <p className="mt-0.5 text-sm font-semibold">{r.jobCount}</p>
                      </div>
                      <div>
                        <p className="label-xs">Done</p>
                        <p className="mt-0.5 text-sm font-semibold">{r.completedCount}</p>
                      </div>
                      <div>
                        <p className="label-xs">Value</p>
                        <p className="mt-0.5 text-sm font-semibold">{money(r.jobValue)}</p>
                      </div>
                      <div>
                        <p className="label-xs">Last done</p>
                        <p className="mt-0.5 text-sm font-semibold">{shortDate(r.lastCompletedAt)}</p>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {resolved ? (
                        <Button size="sm" variant="outline" onClick={() => run("reopen", [r.id])}>
                          <RotateCcw className="size-4" />
                          Undo
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            onClick={() => run("homeowner", [r.id])}
                            title={
                              r.wouldMarket
                                ? "Private homeowner, goes straight into the marketable list"
                                : "Private homeowner, but no recent finished job so no marketing basis"
                            }
                          >
                            {r.wouldMarket ? <Check className="size-4" /> : <User className="size-4" />}
                            Homeowner
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setModal({ decision: "business", ids: [r.id] })}
                            title={
                              r.externalRef && r.externalRef.toLowerCase() !== name.toLowerCase()
                                ? `Creates the company ${r.externalRef} and keeps ${name || "this person"} as its contact`
                                : "Creates a company off this name and keeps the person as its contact"
                            }
                          >
                            <Building2 className="size-4" />
                            Business
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setModal({ decision: "block", ids: [r.id] })}
                            title="Keep the history, never market to them"
                          >
                            <Ban className="size-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setModal({ decision: "archive", ids: [r.id] })}
                            title="Not a client at all"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <p className="mt-3 text-xs text-muted-foreground">
        Homeowner only sets a marketing basis when the last finished job is 2023 or later. Everything else keeps its
        history and stays out of every campaign.
      </p>

      <DecisionModal
        decision={modal?.decision ?? null}
        count={modal?.ids.length ?? 0}
        personName={modalRow ? `${modalRow.firstName} ${modalRow.lastName}`.trim() : ""}
        suggestedCompany={
          modalRow
            ? modalRow.externalRef?.trim() || `${modalRow.firstName} ${modalRow.lastName}`.trim()
            : ""
        }
        pending={resolve.isPending}
        onClose={() => setModal(null)}
        onConfirm={(extra) => modal && run(modal.decision, modal.ids, extra)}
      />
    </Page>
  );
}
