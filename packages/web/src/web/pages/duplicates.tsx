import * as React from "react";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Modal } from "../components/ui/modal";
import { histDate } from "../lib/money";
import { useDuplicates, useMergeContacts } from "../queries/people";

/**
 * DUPLICATE CARDS. Admin only.
 *
 * Cards that share a mobile, an email or a full name. Nothing merges by
 * itself: Damien picks the card to keep and merges one pair at a time. The
 * merged card's jobs, quotes, sites, messages and company links move to the
 * kept card, and the merged card is archived, not deleted.
 */

type Group = NonNullable<ReturnType<typeof useDuplicates>["data"]>[number];
type Person = Group["people"][number];

const REASON: Record<string, string> = { mobile: "Same mobile", email: "Same email", name: "Same name" };
const fullName = (p: Person) => `${p.firstName} ${p.lastName}`.trim() || `Card #${p.id}`;
const isoOf = (v: unknown) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(typeof v === "number" ? v * (v < 1e12 ? 1000 : 1) : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export default function DuplicatesPage() {
  const q = useDuplicates();
  const groups = q.data ?? [];
  const [pair, setPair] = React.useState<{ keep: Person; drop: Person } | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  return (
    <Page
      title="Duplicate cards"
      subtitle="Cards that look like the same person. Pick the card to keep, then merge one pair at a time."
    >
      {done ? (
        <p className="mb-3 rounded-lg border border-[var(--success)]/40 bg-[var(--success)]/10 px-3 py-2 text-sm" aria-live="polite">
          {done}
        </p>
      ) : null}
      {q.isLoading ? (
        <Card>
          <Loading label="Looking for duplicates…" />
        </Card>
      ) : q.error ? (
        <Card>
          <Empty>{q.error instanceof Error ? q.error.message : "Could not load the list."}</Empty>
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <Empty>No duplicate cards found.</Empty>
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {groups.length} {groups.length === 1 ? "group" : "groups"} to check. The busiest card is listed first, it is usually the one to keep.
          </p>
          {groups.map((g) => (
            <GroupCard key={g.key} g={g} onMerge={(keep, drop) => setPair({ keep, drop })} />
          ))}
        </div>
      )}
      <MergeModal
        pair={pair}
        onClose={() => setPair(null)}
        onDone={(msg) => {
          setPair(null);
          setDone(msg);
        }}
      />
    </Page>
  );
}

function GroupCard({ g, onMerge }: { g: Group; onMerge: (keep: Person, drop: Person) => void }) {
  const [keepId, setKeepId] = React.useState(g.people[0]!.id);
  const keep = g.people.find((p) => p.id === keepId) ?? g.people[0]!;
  return (
    <Card>
      <CardHeader title={g.people.map(fullName).join(" / ")} subtitle={g.reasons.map((r) => REASON[r] ?? r).join(", ")} />
      <fieldset className="m-0 grid gap-2 border-0 p-3 md:grid-cols-2">
        <legend className="sr-only">Card to keep</legend>
        {g.people.map((p) => {
          const kept = p.id === keep.id;
          return (
            <div
              key={p.id}
              className={`rounded-lg border p-3 ${kept ? "border-[var(--gold)] bg-[var(--gold)]/10" : "border-border"}`}
            >
              <div className="flex items-start justify-between gap-2">
                <label htmlFor={`keep-${p.id}`} className="flex min-w-0 items-start gap-2">
                  <input
                    id={`keep-${p.id}`}
                    aria-label={`Keep ${fullName(p)}, card ${p.id}`}
                    type="radio"
                    name={`keep-${g.key}`}
                    checked={kept}
                    onChange={() => setKeepId(p.id)}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{fullName(p)}</span>
                    <span className="block text-xs text-muted-foreground">
                      Card #{p.id} · added {histDate(isoOf(p.createdAt))}
                    </span>
                  </span>
                </label>
                <Link to={`/clients/${p.id}`} className="shrink-0 text-xs text-primary hover:underline">
                  Open
                </Link>
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">Mobile</dt>
                <dd className="truncate">{p.mobile || p.phone || "None"}</dd>
                <dt className="text-muted-foreground">Email</dt>
                <dd className="truncate">{p.email || "None"}</dd>
                <dt className="text-muted-foreground">Companies</dt>
                <dd className="truncate">{p.companies.length ? p.companies.join(", ") : "None"}</dd>
                <dt className="text-muted-foreground">Used on</dt>
                <dd>
                  {p.jobs} jobs, {p.quotes} quotes, {p.sites} sites
                </dd>
              </dl>
              {kept ? (
                <p className="mt-2 text-xs font-semibold">Keeping this card</p>
              ) : (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => onMerge(keep, p)}>
                  Merge into {fullName(keep)} <ArrowRight className="size-3.5" />
                </Button>
              )}
            </div>
          );
        })}
      </fieldset>
    </Card>
  );
}

function MergeModal({
  pair,
  onClose,
  onDone,
}: {
  pair: { keep: Person; drop: Person } | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const merge = useMergeContacts();
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => setError(null), [pair]);
  if (!pair) return null;
  const { keep, drop } = pair;

  async function go() {
    if (!pair) return;
    setError(null);
    try {
      await merge.mutateAsync({ keepId: keep.id, dropId: drop.id });
      onDone(`Merged card #${drop.id} into ${fullName(keep)} (card #${keep.id}).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Merge these two cards?"
      subtitle="This moves everything across. The merged card is archived, not deleted."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={go} disabled={merge.isPending}>
            {merge.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Merge
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
        <p>
          <span className="font-semibold">Keep:</span> {fullName(keep)}, card #{keep.id}
        </p>
        <p>
          <span className="font-semibold">Merge and archive:</span> {fullName(drop)}, card #{drop.id}
        </p>
        <p className="text-muted-foreground">
          {drop.jobs} jobs, {drop.quotes} quotes and {drop.sites} sites move to the kept card, with its messages, notes and company links.
          Blank mobile or email on the kept card is filled from the merged one.
        </p>
        {error ? <p className="text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}
