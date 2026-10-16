import * as React from "react";
import { Link, useLocation } from "wouter";
import { AlertTriangle, ArrowLeft, Copy, Search } from "lucide-react";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Checkbox, Input } from "./ui/field";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { ProductFinder } from "./product-finder";
import { errorText } from "./public-shell";
import { unitLabel, useDebounced } from "./quote-pickers";
import { moneyExact, money } from "../lib/money";
import type { FoundProduct } from "../queries/productFind";
import { useCopyCreate, useCopyLinksForJob, useCopyPreview, useCopySearch, useQuotesForClient } from "../queries/quote-copy";

/**
 * Copy from previous job and Duplicate this quote (Damien, 16 Oct, notes 18.46).
 * Pick an old quote, tick the lines to bring across, then make the copy for the
 * same client (a follow-on job) or for another client (lines only).
 */
export function QuoteCopyModal({
  open,
  onClose,
  fromQuoteId = null,
  contactId = null,
  companyId = null,
}: {
  open: boolean;
  onClose: () => void;
  /** Duplicate this quote: skip the search and go straight to the lines. */
  fromQuoteId?: number | null;
  /** The client already picked on New quote. Their quotes come first. */
  contactId?: number | null;
  companyId?: number | null;
}) {
  const [picked, setPicked] = React.useState<number | null>(fromQuoteId);
  React.useEffect(() => {
    if (open) setPicked(fromQuoteId);
  }, [open, fromQuoteId]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={fromQuoteId != null ? "Duplicate this quote" : "Copy from previous job"}
      subtitle="Every line is priced off today's price book and labour rates. Site notes, photos, SWMS, access notes and dates are never copied."
      width="max-w-3xl"
    >
      {picked == null ? (
        <CopySearch contactId={contactId} companyId={companyId} onPick={setPicked} />
      ) : (
        <CopyLines quoteId={picked} onBack={fromQuoteId == null ? () => setPicked(null) : null} onDone={onClose} />
      )}
    </Modal>
  );
}

function CopySearch({
  contactId,
  companyId,
  onPick,
}: {
  contactId: number | null;
  companyId: number | null;
  onPick: (id: number) => void;
}) {
  const [text, setText] = React.useState("");
  const q = useDebounced(text);
  const hits = useCopySearch({ q, contactId, companyId });
  const rows = hits.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search past quotes"
          className="pl-9"
          placeholder="Client name, site address, product or quote number"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {hits.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>No quotes with lines match. Old ServiceM8 jobs have no lines to copy.</Empty>
      ) : (
        <ul className="flex max-h-[55vh] flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onPick(r.id)}
                className="flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-secondary/50"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="tabular">{r.ref}</span>
                    <span>{r.client}</span>
                    {r.pickedClient ? <Badge colour="#3F7D3A">This client</Badge> : null}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.date).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">{r.address ?? "No site"}</div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">{r.mainProducts.join(", ") || "Labour and hand lines only"}</span>
                  <span className="tabular shrink-0 text-muted-foreground">
                    {r.totalM2 > 0 ? `${Math.round(r.totalM2 * 10) / 10} m² · ` : ""}
                    {money(r.total)}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CopyLines({ quoteId, onBack, onDone }: { quoteId: number; onBack: (() => void) | null; onDone: () => void }) {
  const [, navigate] = useLocation();
  const preview = useCopyPreview(quoteId);
  const create = useCopyCreate();
  const [ticks, setTicks] = React.useState<Record<number, boolean>>({});
  const [swaps, setSwaps] = React.useState<Record<number, FoundProduct | null>>({});
  const [finding, setFinding] = React.useState<number | null>(null);
  const [mode, setMode] = React.useState<"same" | "other">("same");
  const [error, setError] = React.useState<string | null>(null);

  const data = preview.data;
  // Ticks start where the server says: everything but site prep.
  React.useEffect(() => {
    if (!data) return;
    setTicks(Object.fromEntries(data.lines.map((l) => [l.itemId, l.ticked])));
    setSwaps({});
    setFinding(null);
    setMode(data.quote.hasClient ? "same" : "other");
  }, [data]);

  if (preview.isLoading) return <Loading />;
  if (preview.error) return <p className="text-sm text-destructive">{errorText(preview.error)}</p>;
  if (!data) return null;

  const lines = data.lines;
  const ticked = lines.filter((l) => ticks[l.itemId]);
  const blocked = ticked.filter((l) => l.missing && !swaps[l.itemId]);
  const checks = ticked.filter((l) => l.checkRequired).length;

  async function submit() {
    setError(null);
    if (!ticked.length) return setError("Tick at least one line.");
    if (blocked.length) return setError("Replace or untick the red lines first.");
    try {
      const r = await create.mutateAsync({
        fromQuoteId: quoteId,
        mode,
        lines: ticked.map((l) => ({ itemId: l.itemId, replaceProductId: swaps[l.itemId]?.id ?? null })),
      });
      onDone();
      navigate(`/quotes/${r.id}`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium">
            {data.quote.ref} · {data.quote.client}
          </div>
          <div className="text-xs text-muted-foreground">{data.quote.address ?? "No site"}</div>
        </div>
        {onBack ? (
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Pick another
          </Button>
        ) : null}
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {lines.map((l) => {
          const on = Boolean(ticks[l.itemId]);
          const swap = swaps[l.itemId] ?? null;
          const red = Boolean(l.missing) && !swap;
          const price = swap ? swap.sellExGst : l.newUnitPrice;
          return (
            <li
              key={l.itemId}
              className={`flex flex-col gap-2 px-3 py-2.5 ${red && on ? "bg-destructive/5" : ""} ${l.linkedTo ? "pl-8" : ""}`}
            >
              <div className="flex items-start gap-3">
                <Checkbox
                  className="mt-0.5"
                  aria-label={`Copy ${l.description}`}
                  checked={on}
                  onChange={(e) => setTicks((t) => ({ ...t, [l.itemId]: e.target.checked }))}
                />
                <div className="min-w-0 flex-1">
                  <div className={`text-sm ${red ? "text-destructive" : ""} ${on ? "" : "text-muted-foreground"}`}>
                    {swap ? `${swap.brand} ${swap.range} ${swap.colour}`.trim() : l.description}
                  </div>
                  {swap ? <div className="text-xs text-muted-foreground line-through">{l.description}</div> : null}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {l.sitePrep ? <Badge>Site prep</Badge> : null}
                    {l.checkRequired ? <Badge colour="#D08A1E">Check required</Badge> : null}
                    {l.keepsOldPrice ? <Badge colour="#5B6E7A">Hand line, keeps its old price</Badge> : null}
                    {red ? (
                      <Badge colour="#B4342A">
                        <AlertTriangle className="size-3" />
                        {l.missing}
                      </Badge>
                    ) : null}
                    {red && on && !l.canReplace ? <span className="text-xs text-destructive">Untick this line.</span> : null}
                  </div>
                </div>
                <div className="shrink-0 text-right text-xs">
                  <div className="tabular">
                    {Math.round(l.qty * 1000) / 1000} {unitLabel(l.unit)}
                  </div>
                  <div className="tabular text-muted-foreground">
                    {price == null ? "no price" : `${moneyExact(price)} today`}
                    {price != null && Math.abs(price - l.oldUnitPrice) >= 0.005 ? (
                      <span className="block line-through">{moneyExact(l.oldUnitPrice)}</span>
                    ) : null}
                  </div>
                </div>
              </div>
              {l.missing && l.canReplace && on ? (
                finding === l.itemId || swap ? (
                  <div className="pl-7">
                    <ProductFinder
                      picked={swap}
                      onPick={(p) => {
                        setSwaps((s) => ({ ...s, [l.itemId]: p }));
                        if (p) setFinding(null);
                      }}
                    />
                  </div>
                ) : (
                  <div className="pl-7">
                    <Button variant="outline" size="sm" onClick={() => setFinding(l.itemId)}>
                      Pick a replacement
                    </Button>
                  </div>
                )
              ) : null}
            </li>
          );
        })}
      </ul>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Who it's for</legend>
        <label className={`flex items-start gap-2 text-sm ${data.quote.hasClient ? "" : "opacity-50"}`}>
          <input
            type="radio"
            name="copy-mode"
            aria-label="Same client, a follow-on job"
            className="mt-1"
            disabled={!data.quote.hasClient}
            checked={mode === "same"}
            onChange={() => setMode("same")}
          />
          <span>
            Same client, a follow-on job
            <span className="block text-xs text-muted-foreground">
              {data.quote.hasClient
                ? `New job at Lead with a new number for ${data.quote.client}, same site, source Repeat client. No access notes.`
                : "That quote has no client on it."}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="copy-mode" aria-label="Another client" className="mt-1" checked={mode === "other"} onChange={() => setMode("other")} />
          <span>
            Another client
            <span className="block text-xs text-muted-foreground">
              Products and quantities only. The job is made when you pick the client on the new quote.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">
          {ticked.length} of {lines.length} lines ticked. {checks} will say Check required until someone confirms them.
          Freight and supplier charges are worked out again.
        </p>
        <Button onClick={submit} disabled={create.isPending || !ticked.length || blocked.length > 0}>
          {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Copy className="size-4" />}
          Make the copy
        </Button>
      </div>
      {blocked.length ? <p className="text-sm text-destructive">Replace or untick the red lines first.</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

/** A small Duplicate button for a quote row on the job page or the client record. */
export function DuplicateQuoteButton({ quoteId }: { quoteId: number }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        title="Duplicate this quote"
        aria-label="Duplicate this quote"
      >
        <Copy className="size-3.5" />
      </button>
      <QuoteCopyModal open={open} onClose={() => setOpen(false)} fromQuoteId={quoteId} />
    </>
  );
}

/** Job page: "Copied from" and "Copied to" under the job's quotes. */
export function JobCopyLinks({ jobId }: { jobId: number }) {
  const links = useCopyLinksForJob(jobId);
  const from = links.data?.from ?? [];
  const to = links.data?.copies ?? [];
  if (!from.length && !to.length) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
      {from.map((l) => (
        <span key={`f${l.id}`}>
          {l.sameClient ? "Follow-on from" : "Copied from"}{" "}
          <Link to={`/quotes/${l.id}`} className="font-medium text-primary hover:underline">
            {l.ref}
          </Link>
        </span>
      ))}
      {to.map((l) => (
        <span key={`t${l.id}`}>
          Copied to{" "}
          <Link to={`/quotes/${l.id}`} className="font-medium text-primary hover:underline">
            {l.ref}
          </Link>
          {l.sameClient ? " as a follow-on" : " for another client"}
        </span>
      ))}
    </div>
  );
}

/** Client record: the newest version of each quote, with its copies listed under the one they came from. */
export function ClientQuotesCard({ contactId = null, companyId = null }: { contactId?: number | null; companyId?: number | null }) {
  const rows = useQuotesForClient({ contactId, companyId });
  const list = rows.data ?? [];
  return (
    <Card>
      <CardHeader title="Quotes" subtitle={list.some((r) => r.copies.length) ? "Copies sit under the quote they came from." : undefined} />
      {rows.isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>No quotes yet.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((q) => (
            <li key={q.id} className="px-4 py-2.5 text-sm">
              <ClientQuoteRow row={q} />
              {q.copies.length ? (
                <ul className="mt-1.5 flex flex-col gap-1 border-l-2 border-border pl-3">
                  {q.copies.map((c) => (
                    <li key={c.id}>
                      <ClientQuoteRow row={c} note={c.sameClient ? "Follow-on" : "Copy, other client"} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ClientQuoteRow({ row, note }: { row: { id: number; ref: string; status: string; total: number }; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2">
        <Link to={`/quotes/${row.id}`} className="font-medium text-primary hover:underline">
          {row.ref}
        </Link>
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </span>
      <span className="flex items-center gap-2">
        <Badge>{row.status}</Badge>
        <span className="tabular">{money(row.total)}</span>
        <DuplicateQuoteButton quoteId={row.id} />
      </span>
    </div>
  );
}
