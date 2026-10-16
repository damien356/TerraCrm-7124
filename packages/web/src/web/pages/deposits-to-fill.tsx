import * as React from "react";
import { Link } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/field";
import { useCardsMissingDeposit, useSetCardDeposit } from "../queries/billTo";

/**
 * DEPOSIT % TO FILL (notes 18.54).
 *
 * Every company and person who pays on an open job but has no deposit % on
 * their card yet. Type the % and it saves on the card. Draft quotes billed to
 * that card pick it up. Sent quotes stay as they went out.
 */

type Row = NonNullable<ReturnType<typeof useCardsMissingDeposit>["data"]>[number];

export default function DepositsToFillPage() {
  const q = useCardsMissingDeposit();
  const rows = q.data ?? [];
  const companies = rows.filter((r) => r.type === "company");
  const people = rows.filter((r) => r.type === "contact");

  return (
    <Page
      title="Deposit % to fill"
      subtitle="Cards that pay on an open job with no deposit % yet. Type each one. It saves on the card, and draft quotes billed to them follow."
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <p className="text-sm text-destructive">{q.error.message}</p>
      ) : rows.length === 0 ? (
        <Card>
          <Empty>Every card that pays on an open job has its deposit %.</Empty>
        </Card>
      ) : (
        <div className="grid gap-4">
          {companies.length ? <Group title={`Companies (${companies.length})`} rows={companies} /> : null}
          {people.length ? <Group title={`People (${people.length})`} rows={people} /> : null}
        </div>
      )}
    </Page>
  );
}

function Group({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="divide-y divide-border">
        {rows.map((r) => (
          <FillRow key={`${r.type}:${r.id}`} row={r} />
        ))}
      </div>
    </Card>
  );
}

function FillRow({ row }: { row: Row }) {
  const save = useSetCardDeposit();
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const href = row.type === "company" ? `/companies/${row.id}` : `/clients/${row.id}`;

  async function submit() {
    setError(null);
    const t = draft.trim();
    const n = Number(t);
    if (t === "" || !Number.isFinite(n) || n < 0 || n > 100) return setError("Type a % between 0 and 100. Type 0 for no deposit.");
    try {
      await save.mutateAsync({ billTo: { type: row.type, id: row.id }, percent: n });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <div className="min-w-[220px] flex-1">
        <Link to={href} className="text-sm font-medium text-primary hover:underline">
          {row.name}
        </Link>
        {row.detail ? <p className="text-xs capitalize text-muted-foreground">{row.detail}</p> : null}
        <p className="text-xs text-muted-foreground">
          Pays on{" "}
          {row.jobs.map((j, i) => (
            <React.Fragment key={j.id}>
              {i ? ", " : ""}
              <Link to={`/jobs/${j.id}`} className="hover:underline">
                {j.ref}
                {j.title ? ` ${j.title}` : ""}
              </Link>
            </React.Fragment>
          ))}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label={`Deposit % for ${row.name}`}
          className="tabular h-8 w-[72px] text-right"
          inputMode="decimal"
          placeholder="%"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <span className="text-xs text-muted-foreground">%</span>
        <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => void submit()}>
          Save on card
        </Button>
      </div>
      {error ? <p className="w-full text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
