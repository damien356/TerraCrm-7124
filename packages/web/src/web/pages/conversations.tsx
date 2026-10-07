import * as React from "react";
import { Link } from "wouter";
import { ChevronDown, MessagesSquare, Paperclip, Search, SlidersHorizontal, X } from "lucide-react";
import { Loading } from "../components/ui/card";
import { cn } from "@/lib/utils";
import { useInbox, useInboxCounts } from "../queries/conversations";
import { useBootstrap } from "../queries/settings";
import { useLogins } from "../queries/team";
import { useCompanies } from "../queries/companies";

/**
 * CONVERSATIONS — the master inbox.
 *
 * Every thread in the business in one list. Two dimensions, because they are
 * different questions: the lane is WHO the talking is with, the scope is WHAT
 * it hangs off. A thread never leaves its job, so a row always says which job
 * it belongs to and clicking it lands you in that job's thread.
 *
 * Unread is personal, off your own read marker.
 */

const LANES = [
  { id: "all", label: "All", countKey: "all" },
  { id: "unread", label: "Unread", countKey: "unread" },
  { id: "customers", label: "Customers", countKey: "customers" },
  { id: "installers", label: "Installers", countKey: "installers" },
  { id: "suppliers", label: "Suppliers", countKey: "suppliers" },
  { id: "internal", label: "Internal", countKey: "internal" },
] as const;

const KINDS = [
  { id: "all", label: "Jobs and quotes" },
  { id: "jobs", label: "Jobs only" },
  { id: "quotes", label: "Quotes only" },
  { id: "clients", label: "Clients, no work yet" },
  { id: "unmatched", label: "Unmatched replies" },
] as const;

type Lane = (typeof LANES)[number]["id"];
type Kind = (typeof KINDS)[number]["id"];

/** Pastel avatar tints, picked off the name so a person keeps their colour. */
const TINTS = [
  { bg: "#F2E3CE", fg: "#7A5A2E" },
  { bg: "#D8EFDC", fg: "#2F6B41" },
  { bg: "#FBE6B8", fg: "#8A6410" },
  { bg: "#F8D9DC", fg: "#8E3B45" },
  { bg: "#DCE8F7", fg: "#2F5D8C" },
  { bg: "#E8DFF6", fg: "#5D4487" },
  { bg: "#E3EDD6", fg: "#4E6B2F" },
];

function tintFor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 9973;
  return TINTS[h % TINTS.length];
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Today reads as a clock, this week as a weekday, older as a date. */
function when(value: string | Date | null) {
  if (!value) return "";
  const d = new Date(value);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  if ((now.getTime() - d.getTime()) / 86400000 < 7)
    return d.toLocaleDateString("en-AU", { weekday: "short" });
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

/** "3/18 Strathaird Rd" reads as "Strathaird Rd". The number is on the job. */
const streetName = (address: string) =>
  address
    .split(",")[0]
    .replace(/^[\d/\-\s]+/, "")
    .trim();

type Row = {
  id: number;
  ref: string | null;
  subject: string | null;
  jobId: number | null;
  quoteId: number | null;
  contactId: number | null;
  originQuoteNumber: string | null;
  state: string;
  lastMessageAt: string | Date | null;
  lastMessagePreview: string | null;
  jobNumber: number | string | null;
  jobStatus: string;
  siteAddress: string;
  siteSuburb: string;
  contactName: string;
  companyName: string;
  installerNames: string;
  supplierNames: string;
  unread: number;
  messageCount: number;
  lastChannel: string;
  lastAudience: string;
  lastDirection: string;
  lastAuthor: string;
  attachmentCount: number;
};

/** Where a row takes you: the job's thread, else the quote, else the client. */
function href(r: Row) {
  if (r.jobId) return `/jobs/${r.jobId}?tab=conversation`;
  if (r.quoteId) return `/quotes/${r.quoteId}`;
  if (r.contactId) return `/clients/${r.contactId}`;
  return "/conversations";
}

function ThreadRow({ r }: { r: Row }) {
  const unread = r.unread > 0;
  const place = streetName(r.siteAddress) || r.siteSuburb;

  /* The handle: the job it belongs to, or the quote it is still sitting on. */
  const title = r.jobNumber
    ? `#${r.jobNumber}${place ? ` ${place}` : ""}`
    : r.originQuoteNumber
      ? `${r.originQuoteNumber}${place ? ` ${place}` : ""}`
      : r.subject || r.companyName || r.contactName || "Untitled thread";

  /* Who is on the other side, one line each, the way the mockup reads. */
  const who: string[] = [];
  const onWork = Boolean(r.jobNumber || r.quoteId);
  if (r.contactName) who.push(onWork ? `Customer: ${r.contactName}` : r.contactName);
  else if (r.companyName) who.push(onWork ? `Customer: ${r.companyName}` : r.companyName);
  if (r.installerNames) who.push(`Installer: ${r.installerNames}`);
  if (r.supplierNames) who.push(`Supplier: ${r.supplierNames}`);

  const avatarName = r.contactName || r.installerNames || r.supplierNames || r.companyName || title;
  const tint = tintFor(avatarName);

  return (
    <Link
      to={href(r)}
      className="flex items-start gap-3 border-b border-border px-4 py-3.5 transition-colors last:border-0 hover:bg-secondary/40"
    >
      <span
        className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold"
        style={{ backgroundColor: tint.bg, color: tint.fg }}
      >
        {initials(avatarName)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className={cn("truncate text-[15px] leading-tight", unread ? "font-semibold" : "font-medium")}>
            {title}
          </p>
          {r.state === "unassigned" ? (
            <span className="shrink-0 rounded-full bg-[#C0603F]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#C0603F]">
              Unmatched
            </span>
          ) : null}
        </div>

        {who.map((line) => (
          <p key={line} className="mt-0.5 truncate text-[13px] leading-snug text-muted-foreground">
            {line}
          </p>
        ))}

        <p
          className={cn(
            "mt-0.5 flex items-center gap-1.5 text-[13px] leading-snug",
            unread ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {r.attachmentCount ? <Paperclip className="size-3 shrink-0" /> : null}
          <span className="truncate">
            {r.lastDirection === "out" ? "You: " : ""}
            {r.lastMessagePreview || "No messages yet"}
          </span>
        </p>
      </div>

      <div className="flex w-[78px] shrink-0 flex-col items-end gap-1.5">
        <span className="whitespace-nowrap text-[12px] text-muted-foreground">{when(r.lastMessageAt)}</span>
        {unread ? (
          <span className="tabular flex size-[22px] items-center justify-center rounded-full bg-[#2563EB] text-[11px] font-semibold text-white">
            {r.unread}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

export default function InboxPage() {
  const [lane, setLane] = React.useState<Lane>("all");
  const [kind, setKind] = React.useState<Kind>("all");
  const [companyId, setCompanyId] = React.useState("");
  const [staffId, setStaffId] = React.useState("");
  const [jobStatus, setJobStatus] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [more, setMore] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const counts = useInboxCounts();
  const bootstrap = useBootstrap();
  const logins = useLogins();
  const companies = useCompanies();

  const inbox = useInbox({
    lane,
    kind,
    search: debounced || undefined,
    companyId: companyId ? Number(companyId) : undefined,
    staffProfileId: staffId ? Number(staffId) : undefined,
    jobStatus: jobStatus || undefined,
    from: from || undefined,
    to: to || undefined,
  });
  const rows = (inbox.data ?? []) as Row[];

  const narrowed =
    kind !== "all" || Boolean(companyId || staffId || jobStatus || from || to);

  function clearAll() {
    setKind("all");
    setCompanyId("");
    setStaffId("");
    setJobStatus("");
    setFrom("");
    setTo("");
  }

  const selectClass =
    "h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] outline-none focus:border-primary/50";

  return (
    <div className="px-6 py-6">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="card-surface overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-4 pt-4">
            <h1 className="text-[22px] font-bold tracking-[-0.01em]">All conversations</h1>
            {counts.data?.unread ? (
              <span className="tabular rounded-full bg-[#2563EB] px-2.5 py-1 text-[11px] font-semibold text-white">
                {counts.data.unread} unread
              </span>
            ) : null}
          </div>

          {/* Search */}
          <div className="px-4 pt-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                aria-label="Search conversations"
                className="h-11 w-full rounded-xl border border-border bg-card pl-9 pr-10 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/50"
                placeholder="Search job, address, name, message, file…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setMore((v) => !v)}
                className={cn(
                  "absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg transition-colors",
                  more || narrowed ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary",
                )}
                aria-label="More filters"
              >
                {more ? <ChevronDown className="size-4" /> : <SlidersHorizontal className="size-4" />}
              </button>
            </div>
          </div>

          {/* Lanes */}
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            {LANES.map((l) => {
              const active = lane === l.id;
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLane(l.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-[13px] font-medium transition-colors",
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-card text-foreground/70 hover:bg-secondary",
                  )}
                >
                  {l.label}
                  {counts.data?.[l.countKey] ? (
                    <span
                      className={cn(
                        "tabular text-[11px]",
                        active ? "text-background/70" : "text-muted-foreground",
                      )}
                    >
                      {counts.data[l.countKey]}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* The rest of the filters, out of the way until wanted */}
          {more ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border bg-secondary/30 px-4 py-3">
              <select className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
              <select className={selectClass} value={jobStatus} onChange={(e) => setJobStatus(e.target.value)}>
                <option value="">Any status</option>
                {(bootstrap.data?.allStatuses ?? []).map((s: { id: number; name: string }) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select className={selectClass} value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                <option value="">Any company</option>
                {(companies.data ?? []).map((c: { id: number; name: string }) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select className={selectClass} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                <option value="">Any staff member</option>
                {(logins.data ?? [])
                  .filter((l: { role: string }) => l.role === "admin")
                  .map((l: { id: number; name: string }) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
              <input
                type="date"
                className={selectClass}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="From"
              />
              <input
                type="date"
                className={selectClass}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-label="To"
              />
              {narrowed ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:underline"
                >
                  <X className="size-3.5" />
                  Clear
                </button>
              ) : null}
            </div>
          ) : null}

          {/* The list */}
          {inbox.isLoading ? (
            <Loading label="Reading the inbox…" />
          ) : rows.length === 0 ? (
            <div className="border-t border-border px-4 py-14 text-center">
              <MessagesSquare className="mx-auto size-6 text-muted-foreground/40" />
              <p className="mt-2 text-sm text-muted-foreground">
                {debounced || narrowed || lane !== "all"
                  ? "Nothing matches that."
                  : "No conversations yet. A thread opens the first time you write to a customer or crew from a job or a quote, or when a reply lands."}
              </p>
            </div>
          ) : (
            <div className="border-t border-border">
              {rows.map((r) => (
                <ThreadRow key={r.id} r={r} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
