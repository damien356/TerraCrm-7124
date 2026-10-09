import * as React from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Select } from "../components/ui/field";
import { orpc } from "../lib/api";
import { useCompanyTypes } from "../queries/people";
import { COMPANY_TYPES, COMPANY_TYPE_LABELS } from "../../api/lib/person-tags";

/**
 * COMPANY TYPES.
 *
 * Almost every company came in from the import as a builder. This list puts
 * the ones that read like a real estate agency or an insurer first, with a
 * suggested type, so they can be fixed one by one. Saving goes through the
 * normal company update, so deposit terms follow the new type.
 */

/** Cards flagged by hand in the job contacts plan as probably not builders. */
const SUSPECT_IDS = new Set([
  22, 35, 45, 68, 70, 77, 81, 89, 91, 103, 120, 154, 157, 160, 162, 171, 175, 195, 197, 198, 216, 218, 222, 223, 284,
]);

type Row = NonNullable<ReturnType<typeof useCompanyTypes>["data"]>[number];
type Filter = "check" | "all";

export default function CompanyTypesPage() {
  const q = useCompanyTypes();
  const [filter, setFilter] = React.useState<Filter>("check");
  const [search, setSearch] = React.useState("");
  const rows = q.data ?? [];
  const flagged = (r: Row) => !!r.suggested || (SUSPECT_IDS.has(r.id) && r.type === "builder");
  const s = search.trim().toLowerCase();
  const shown = rows
    .filter((r) => (filter === "check" ? flagged(r) : true))
    .filter((r) => !s || r.name.toLowerCase().includes(s))
    .sort((a, b) => Number(flagged(b)) - Number(flagged(a)) || a.name.localeCompare(b.name));
  const counts = COMPANY_TYPES.map((t) => [t, rows.filter((r) => r.type === t).length] as const).filter(([, n]) => n > 0);

  return (
    <Page
      title="Company types"
      subtitle="Fix companies saved as the wrong type. Real estate agencies and insurers count separately from builders."
      actions={
        <Link to="/companies" className="text-[13px] text-primary hover:underline">
          Back to companies
        </Link>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {(
            [
              ["check", `To check (${rows.filter(flagged).length})`],
              ["all", `All (${rows.length})`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
              className={`px-3 py-2 text-[13px] ${filter === k ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="max-w-xs flex-1">
          <Input placeholder="Company name…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search companies" />
        </div>
        <p className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto">
          {counts.map(([t, n]) => `${n} ${COMPANY_TYPE_LABELS[t]?.toLowerCase() ?? t}`).join(" · ")}
        </p>
      </div>

      <Card>
        <CardHeader
          title={filter === "check" ? "Probably not builders" : "Every active company"}
          subtitle="A builder starts new quotes at 0% deposit. Any other type follows the QBCC cap for the quote total, unless the company has its own deposit set (still never above the cap)."
        />
        {q.isLoading ? (
          <Loading label="Loading companies…" />
        ) : shown.length === 0 ? (
          <Empty>{filter === "check" ? "Nothing left to check." : "No companies match."}</Empty>
        ) : (
          <div className="divide-y divide-border">
            {shown.map((r) => (
              <TypeRow key={r.id} r={r} flagged={flagged(r)} />
            ))}
          </div>
        )}
      </Card>
    </Page>
  );
}

function TypeRow({ r, flagged }: { r: Row; flagged: boolean }) {
  const qc = useQueryClient();
  const update = useMutation(
    orpc.companies.update.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: orpc.people.key() });
        qc.invalidateQueries({ queryKey: orpc.companies.key() });
        qc.invalidateQueries({ queryKey: orpc.finance.key() });
        qc.invalidateQueries({ queryKey: orpc.dashboard.key() });
      },
    }),
  );
  const [type, setType] = React.useState(r.suggested ?? r.type);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  React.useEffect(() => setType(r.suggested ?? r.type), [r.suggested, r.type]);

  const changed = type !== r.type;
  const depositNote =
    changed && r.depositPercent == null && (r.type === "builder") !== (type === "builder")
      ? `New quotes will start at ${type === "builder" ? "0" : "50"}% deposit.`
      : null;

  async function save() {
    setError(null);
    setSaved(false);
    try {
      await update.mutateAsync({ id: r.id, type });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={`flex flex-wrap items-center gap-3 px-4 py-2.5 ${flagged ? "" : "opacity-90"}`}>
      <div className="min-w-0 flex-1 basis-56">
        <Link to={`/companies/${r.id}`} className="font-medium text-primary hover:underline">
          {r.name}
        </Link>
        <p className="text-xs text-muted-foreground">
          #{r.id} · now {COMPANY_TYPE_LABELS[r.type] ?? r.type} · {r.jobs} jobs · {r.people} people
          {r.suggested ? (
            <span className="ml-1 font-semibold text-[var(--warning)]">Looks like {COMPANY_TYPE_LABELS[r.suggested]?.toLowerCase()}</span>
          ) : flagged ? (
            <span className="ml-1 font-semibold text-[var(--warning)]">Flagged to check</span>
          ) : null}
        </p>
        {depositNote ? <p className="text-xs text-muted-foreground">{depositNote}</p> : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <Select value={type} onChange={(e) => setType(e.target.value)} aria-label={`Type for ${r.name}`} className="w-[190px]">
          {COMPANY_TYPES.map((t) => (
            <option key={t} value={t}>
              {COMPANY_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
        <Button size="sm" onClick={save} disabled={!changed || update.isPending}>
          {update.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
          Save
        </Button>
        {saved && !changed ? <span className="text-xs text-[var(--success)]">Saved</span> : null}
      </div>
    </div>
  );
}
