import * as React from "react";
import {
  AlertTriangle,
  Check,
  HardHat,
  Home,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import {
  useAudienceReviewQueue,
  useCreateSegment,
  useDeleteSegment,
  useSegment,
  useSegmentOptions,
  useSegmentPreview,
  useSegments,
  useSetAudience,
  useUpdateSegment,
} from "../queries/segments";

/**
 * Segments — who a message is allowed to go to.
 *
 * The one rule this page enforces visually: every count is shown as a pair.
 * `matching` is who fits the rules, `reachable` is who may lawfully be
 * emailed. A segment of 300 that can only be mailed to 40 is a consent
 * problem, and showing one number is how a business ends up sending to the
 * other 260. So the gap is always on screen, never behind a tooltip.
 */

type Rules = {
  suburbs: string[];
  products: string[];
  completedWithinDays: number | null;
  completedBeforeDays: number | null;
  sources: string[];
  minJobValue: number | null;
  requireEmail: boolean;
};

type Draft = {
  name: string;
  description: string;
  audience: "homeowner" | "builder";
  rules: Rules;
};

const BLANK_RULES: Rules = {
  suburbs: [],
  products: [],
  completedWithinDays: null,
  completedBeforeDays: null,
  sources: [],
  minJobValue: null,
  requireEmail: true,
};

const BLANK: Draft = {
  name: "",
  description: "",
  audience: "homeowner",
  rules: BLANK_RULES,
};

/** Terra's obvious starting points, so nobody builds these from scratch. */
const STARTERS: { name: string; description: string; rules: Partial<Rules> }[] = [
  {
    name: "Carpet, last 2 years",
    description: "Recent carpet customers — the people a carpet care or upgrade message is for.",
    rules: { products: ["carpet"], completedWithinDays: 730 },
  },
  {
    name: "Dormant, 3 years+",
    description: "Finished a floor three years ago and not seen since.",
    rules: { completedBeforeDays: 1095 },
  },
  {
    name: "Timber and hybrid owners",
    description: "Hard-floor customers, for a recoat or a matching second room.",
    rules: { products: ["timber", "hybrid"] },
  },
];

function useDebounced<T>(value: T, ms = 450) {
  const [held, setHeld] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return held;
}

/** Drops the empties, so the rule blob stays readable in the database. */
function cleanRules(r: Rules) {
  return {
    ...(r.suburbs.length ? { suburbs: r.suburbs } : {}),
    ...(r.products.length ? { products: r.products } : {}),
    ...(r.completedWithinDays ? { completedWithinDays: r.completedWithinDays } : {}),
    ...(r.completedBeforeDays ? { completedBeforeDays: r.completedBeforeDays } : {}),
    ...(r.sources.length ? { sources: r.sources } : {}),
    ...(r.minJobValue ? { minJobValue: r.minJobValue } : {}),
    requireEmail: r.requireEmail,
  };
}

/* ---------------------------------------------------------------------------
 * The count pair. The whole point of the page.
 * ------------------------------------------------------------------------- */

type Counts = {
  matching: number;
  reachable: number;
  blocked: { noEmail: number; noConsent: number; doNotMarket: number; unsubscribed: number };
};

function CountPair({ counts, size = "md" }: { counts: Counts; size?: "sm" | "md" }) {
  const held = counts.matching - counts.reachable;
  const big = size === "md";

  return (
    <div className="flex items-baseline gap-4">
      <div>
        <p className={big ? "text-2xl font-semibold tabular-nums" : "text-base font-semibold tabular-nums"}>
          {counts.reachable}
        </p>
        <p className="label-xs">can be emailed</p>
      </div>
      <div className="text-muted-foreground">
        <p className={big ? "text-2xl font-semibold tabular-nums" : "text-base font-semibold tabular-nums"}>
          {counts.matching}
        </p>
        <p className="label-xs">match the rules</p>
      </div>
      {held > 0 ? (
        <Badge colour="#BC9558">{held} held back</Badge>
      ) : counts.matching > 0 ? (
        <Badge colour="#4F7A5B">all reachable</Badge>
      ) : null}
    </div>
  );
}

/** Why the rest cannot be mailed. The numbers overlap, so it says so. */
function BlockedBreakdown({ counts }: { counts: Counts }) {
  const rows = [
    { label: "No email address", n: counts.blocked.noEmail },
    { label: "No consent basis", n: counts.blocked.noConsent },
    { label: "Marked do-not-market", n: counts.blocked.doNotMarket },
    { label: "Unsubscribed", n: counts.blocked.unsubscribed },
  ].filter((r) => r.n > 0);

  if (!rows.length) return null;

  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <p className="label-xs mb-1.5">Why the rest are held back</p>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {rows.map((r) => (
          <li key={r.label} className="flex justify-between gap-3">
            <span>{r.label}</span>
            <span className="tabular-nums">{r.n}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-muted-foreground/80">
        A contact can be in more than one of these, so they don't add up to the gap.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Page
 * ------------------------------------------------------------------------- */

export default function SegmentsPage() {
  const list = useSegments();
  const review = useAudienceReviewQueue(200);
  const [editingId, setEditingId] = React.useState<number | null>(null);
  const [creating, setCreating] = React.useState<Draft | null>(null);
  const [reviewOpen, setReviewOpen] = React.useState(false);

  const heldBack = review.data?.rows.length ?? 0;

  return (
    <Page
      title="Segments"
      subtitle="Saved questions about the contact book, re-run every time they're read. Nobody goes stale."
      actions={
        <Button onClick={() => setCreating(BLANK)}>
          <Plus className="size-4" />
          New segment
        </Button>
      }
    >
      {/* The trade review queue. Sits above the segments because it changes
        * every number below it. */}
      {heldBack > 0 ? (
        <Card className="mb-4 border-[#BC9558]/40">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-start gap-2.5">
              <HardHat className="mt-0.5 size-4 shrink-0 text-[#BC9558]" />
              <div>
                <p className="text-sm font-medium">
                  {heldBack} contact{heldBack === 1 ? "" : "s"} look like trade, not homeowners
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  They're being held out of every homeowner segment until someone says which they are.
                  Builders, agents and shopfitters shouldn't get a "how's your new floor" email.
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setReviewOpen(true)}>
              Review them
            </Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Segments"
          subtitle={
            list.data ? `${list.data.length} segment${list.data.length === 1 ? "" : "s"}` : undefined
          }
        />
        {list.isPending ? (
          <Loading label="Counting each segment against the contact book…" />
        ) : !list.data?.length ? (
          <Empty>
            No segments yet. Start from one of these, or build your own.
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {STARTERS.map((s) => (
                <Button
                  key={s.name}
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setCreating({
                      name: s.name,
                      description: s.description,
                      audience: "homeowner",
                      rules: { ...BLANK_RULES, ...s.rules },
                    })
                  }
                >
                  <Plus className="size-3.5" />
                  {s.name}
                </Button>
              ))}
            </div>
          </Empty>
        ) : (
          <div className="divide-y divide-border">
            {list.data.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setEditingId(s.id)}
                className="flex w-full flex-wrap items-center justify-between gap-4 px-4 py-3 text-left hover:bg-accent/50"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {s.audience === "builder" ? (
                      <HardHat className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Home className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {s.audience === "builder" ? <Badge>builder · no journeys</Badge> : null}
                    {s.sendCount > 0 ? (
                      <Badge colour="#BC9558">
                        {s.sendCount} sent
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate pl-6 text-xs text-muted-foreground">{s.summary}</p>
                </div>
                <CountPair counts={s.counts} size="sm" />
              </button>
            ))}
          </div>
        )}
      </Card>

      {creating ? <Editor initial={creating} onClose={() => setCreating(null)} /> : null}
      {editingId !== null ? <Editor id={editingId} onClose={() => setEditingId(null)} /> : null}
      {reviewOpen ? <AudienceReview onClose={() => setReviewOpen(false)} /> : null}
    </Page>
  );
}

/* ---------------------------------------------------------------------------
 * Editor
 * ------------------------------------------------------------------------- */

function Editor({
  id,
  initial,
  onClose,
}: {
  id?: number;
  initial?: Draft;
  onClose: () => void;
}) {
  const loaded = useSegment(id ?? null);
  const options = useSegmentOptions();
  const create = useCreateSegment();
  const update = useUpdateSegment();
  const remove = useDeleteSegment();

  const [draft, setDraft] = React.useState<Draft>(initial ?? BLANK);
  const [ready, setReady] = React.useState(id === undefined);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (id === undefined || ready || !loaded.data) return;
    const s = loaded.data.segment;
    setDraft({
      name: s.name,
      description: s.description,
      audience: s.audience as "homeowner" | "builder",
      rules: {
        suburbs: s.rules.suburbs ?? [],
        products: s.rules.products ?? [],
        completedWithinDays: s.rules.completedWithinDays ?? null,
        completedBeforeDays: s.rules.completedBeforeDays ?? null,
        sources: s.rules.sources ?? [],
        minJobValue: s.rules.minJobValue ?? null,
        requireEmail: s.rules.requireEmail !== false,
      },
    });
    setReady(true);
  }, [id, ready, loaded.data]);

  const debounced = useDebounced(draft);
  const preview = useSegmentPreview({
    audience: debounced.audience,
    rules: cleanRules(debounced.rules),
    enabled: ready,
  });

  const setRules = (patch: Partial<Rules>) =>
    setDraft((d) => ({ ...d, rules: { ...d.rules, ...patch } }));

  const toggle = (key: "suburbs" | "products" | "sources", value: string) =>
    setDraft((d) => {
      const current = d.rules[key];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      return { ...d, rules: { ...d.rules, [key]: next } };
    });

  const save = async () => {
    setError(null);
    if (!draft.name.trim()) {
      setError("Give the segment a name.");
      return;
    }
    const payload = {
      name: draft.name,
      description: draft.description,
      audience: draft.audience,
      rules: cleanRules(draft.rules),
    };
    try {
      if (id === undefined) await create.mutateAsync(payload);
      else await update.mutateAsync({ id, ...payload });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that.");
    }
  };

  const del = async () => {
    setError(null);
    if (id === undefined) return;
    try {
      await remove.mutateAsync({ id });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete that.");
    }
  };

  const busy = create.isPending || update.isPending;
  const counts = preview.data?.counts;
  const warnings = preview.data?.warnings ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-5xl"
      title={id === undefined ? "New segment" : draft.name || "Segment"}
      subtitle="Both counts update as you change the rules. The gap between them is a consent problem, not a rounding error."
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          {id !== undefined ? (
            <Button variant="ghost" size="sm" onClick={del} disabled={remove.isPending}>
              <Trash2 className="size-4" />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      }
    >
      {id !== undefined && !ready ? (
        <Loading label="Loading segment…" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {/* ---- Left: the rules ---- */}
          <div className="space-y-4">
            <Field label="Name" hint="Internal only. Nobody outside the office sees it.">
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Carpet, last 2 years"
              />
            </Field>

            <Field label="What it's for" hint="A line for whoever opens this in a year.">
              <Textarea
                rows={2}
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                placeholder="Recent carpet customers — for a care or upgrade message."
              />
            </Field>

            <Field
              label="Audience"
              hint="Builder segments can never be used by a journey. Enforced on the server, not just here."
            >
              <Select
                value={draft.audience}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, audience: e.target.value as "homeowner" | "builder" }))
                }
              >
                <option value="homeowner">Homeowners</option>
                <option value="builder">Builders and trade</option>
              </Select>
            </Field>

            <div>
              <p className="label-xs mb-1.5">Product installed</p>
              <div className="flex flex-wrap gap-1.5">
                {(options.data?.products ?? []).map((p) => {
                  const on = draft.rules.products.includes(p.key);
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => toggle("products", p.key)}
                      className={
                        on
                          ? "rounded-md border border-primary bg-primary/10 px-2 py-1 text-xs"
                          : "rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
                      }
                    >
                      {p.label}
                      <span className="ml-1.5 text-muted-foreground tabular-nums">{p.n}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Matched on what the office typed in ServiceM8, so "Carpet", "carpet" and
                "Broadloom carpet install" all count as carpet.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Finished within" hint="Days">
                <Input
                  type="number"
                  min={1}
                  value={draft.rules.completedWithinDays ?? ""}
                  onChange={(e) =>
                    setRules({ completedWithinDays: e.target.value ? Number(e.target.value) : null })
                  }
                  placeholder="730"
                />
              </Field>
              <Field label="Not seen for" hint="Days. The dormant case.">
                <Input
                  type="number"
                  min={1}
                  value={draft.rules.completedBeforeDays ?? ""}
                  onChange={(e) =>
                    setRules({ completedBeforeDays: e.target.value ? Number(e.target.value) : null })
                  }
                  placeholder="1095"
                />
              </Field>
            </div>

            <Field label="Spent at least" hint="Total value of their completed jobs, dollars.">
              <Input
                type="number"
                min={1}
                value={draft.rules.minJobValue ?? ""}
                onChange={(e) =>
                  setRules({ minJobValue: e.target.value ? Number(e.target.value) : null })
                }
                placeholder="5000"
              />
            </Field>

            <div>
              <p className="label-xs mb-1.5">
                Suburb{draft.rules.suburbs.length ? ` · ${draft.rules.suburbs.length} chosen` : ""}
              </p>
              <div className="max-h-40 overflow-y-auto rounded-md border border-border p-2">
                <div className="flex flex-wrap gap-1.5">
                  {(options.data?.suburbs ?? []).map((s) => {
                    const on = draft.rules.suburbs.includes(s.value);
                    return (
                      <button
                        key={s.value}
                        type="button"
                        onClick={() => toggle("suburbs", s.value)}
                        className={
                          on
                            ? "rounded-md border border-primary bg-primary/10 px-2 py-0.5 text-[11px]"
                            : "rounded-md border border-border bg-background px-2 py-0.5 text-[11px] hover:bg-accent"
                        }
                      >
                        {s.value}
                        <span className="ml-1 text-muted-foreground tabular-nums">{s.n}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Nothing chosen means anywhere.
              </p>
            </div>

            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={draft.rules.requireEmail}
                onChange={(e) => setRules({ requireEmail: e.target.checked })}
              />
              <span>
                Must have an email address
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Turn this off only for a list you're exporting for post or phone.
                </span>
              </span>
            </label>
          </div>

          {/* ---- Right: who that actually is ---- */}
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              {preview.isPending ? (
                <Loading label="Counting…" />
              ) : counts ? (
                <>
                  <CountPair counts={counts} />
                  <p className="mt-2 text-xs text-muted-foreground">{preview.data?.summary}</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Set a rule to see who's in it.</p>
              )}
            </div>

            {counts ? <BlockedBreakdown counts={counts} /> : null}

            {warnings.map((w) => (
              <div
                key={w}
                className="flex items-start gap-2 rounded-md border border-[#BC9558]/50 bg-[#BC9558]/10 px-3 py-2 text-xs"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#BC9558]" />
                <span>{w}</span>
              </div>
            ))}

            {draft.audience === "builder" ? (
              <div className="flex items-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                <HardHat className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  A builder segment can't be attached to a journey — only to a one-off send someone
                  writes and approves.
                </span>
              </div>
            ) : null}

            <div>
              <p className="label-xs mb-1.5">Who's in it</p>
              <div className="max-h-[22rem] overflow-y-auto rounded-md border border-border">
                {!preview.data?.sample.length ? (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    Nobody matches these rules.
                  </p>
                ) : (
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-border">
                      {preview.data.sample.map((m) => (
                        <tr key={m.id} className={m.reachable ? "" : "text-muted-foreground"}>
                          <td className="px-2.5 py-1.5">
                            <span className="font-medium">{m.name || "—"}</span>
                            <span className="ml-1.5">{m.suburb}</span>
                          </td>
                          <td className="px-2.5 py-1.5 text-right">
                            {m.reachable ? (
                              <Check className="inline size-3.5 text-[#4F7A5B]" />
                            ) : (
                              <span className="text-[11px]">held back</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Most recent job first, up to 25. Greyed rows match the rules but can't be emailed.
              </p>
            </div>
          </div>
        </div>
      )}

      {error ? (
        <p className="mt-4 flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
 * Audience review — the human override on the homeowner/trade guess
 * ------------------------------------------------------------------------- */

function AudienceReview({ onClose }: { onClose: () => void }) {
  const queue = useAudienceReviewQueue(200);
  const setAudience = useSetAudience();
  const [pending, setPending] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const decide = async (contactId: number, kind: "homeowner" | "trade") => {
    setError(null);
    setPending(contactId);
    try {
      await setAudience.mutateAsync({ contactId, audienceKind: kind });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that.");
    } finally {
      setPending(null);
    }
  };

  const totals = queue.data?.totals;

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-3xl"
      title="Homeowner or trade?"
      subtitle="Everyone here is held out of homeowner segments until someone rules on them. A decision here beats the guess, permanently."
      footer={
        <Button onClick={onClose}>Done</Button>
      }
    >
      {queue.isPending ? (
        <Loading label="Finding who's unclear…" />
      ) : (
        <>
          {totals ? (
            <p className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Users className="size-3.5" />
              {totals.homeowner} confirmed homeowner · {totals.trade} confirmed trade ·{" "}
              {totals.unknown} not yet reviewed
            </p>
          ) : null}

          {!queue.data?.rows.length ? (
            <Empty>Nobody's waiting on a decision. Every segment count below is trustworthy.</Empty>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {queue.data.rows.map((r) => (
                <div key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {r.name || "—"}
                      {r.jobCount > 0 ? (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {r.jobCount} job{r.jobCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{r.email}</p>
                    <p className="mt-0.5 text-[11px] text-[#BC9558]">{r.reasons.join(" · ")}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending === r.id}
                      onClick={() => decide(r.id, "homeowner")}
                    >
                      <Home className="size-3.5" />
                      Homeowner
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending === r.id}
                      onClick={() => decide(r.id, "trade")}
                    >
                      <HardHat className="size-3.5" />
                      Trade
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="mt-3 text-[11px] text-muted-foreground">
            Worst first: most completed jobs at the top, because that's where the real trade
            accounts are. Only people who could otherwise be emailed are listed.
          </p>

          {error ? (
            <p className="mt-3 flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
