import * as React from "react";
import { Search, UserPlus, UserX } from "lucide-react";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/field";
import { useContacts } from "../queries/contacts";
import { useQuoteCustomerHelp, useSetQuoteCustomer } from "../queries/quotes";

/**
 * Shown on a quote with nobody on it. When the quote came from a recording,
 * it says "Customer not found", shows what was said, the closest clients
 * already in the system, and a new client form filled in from the words.
 * One tap attaches or creates, without leaving the quote.
 */

function useDebounced(value: string, ms = 250) {
  const [out, setOut] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

type Row = { id: number; name: string; detail: string };

function ChoiceButton({ row, disabled, onPick }: { row: Row; disabled: boolean; onPick: (id: number) => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(row.id)}
      className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:border-[var(--gold)]"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{row.name}</span>
        {row.detail ? <span className="block truncate text-xs text-muted-foreground">{row.detail}</span> : null}
      </span>
      <span className="shrink-0 text-xs font-medium text-[var(--gold-deep)]">Use</span>
    </button>
  );
}

/** Anyone else in the system, by name, mobile or email. Only mounted once something is typed. */
function ClientSearch({ q, disabled, onPick }: { q: string; disabled: boolean; onPick: (id: number) => void }) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const found = useContacts({ search: words[words.length - 1] ?? q });
  if (found.isLoading) return <p className="text-xs text-muted-foreground">Searching…</p>;
  const rows: Row[] = (found.data ?? [])
    .filter((c) => {
      const hay = `${c.firstName} ${c.lastName} ${c.email ?? ""} ${c.mobile ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, 8)
    .map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      detail: [c.mobile, c.email, c.suburb].filter(Boolean).join(" · "),
    }));
  if (!rows.length) return <p className="text-xs text-muted-foreground">Nobody by that in the system.</p>;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <ChoiceButton key={r.id} row={r} disabled={disabled} onPick={onPick} />
      ))}
    </div>
  );
}

export function QuoteCustomerPanel({ quoteId, onDone }: { quoteId: number; onDone?: (name: string) => void }) {
  const help = useQuoteCustomerHelp(quoteId, true);
  const setCustomer = useSetQuoteCustomer();
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const q = useDebounced(search.trim());
  const [form, setForm] = React.useState({
    firstName: "",
    lastName: "",
    mobile: "",
    email: "",
    address: "",
    suburb: "",
    postcode: "",
  });
  const filled = React.useRef(false);

  const spoken = help.data?.spoken ?? null;
  const candidates = help.data?.candidates ?? [];

  // Fill the form once from what was said, without stomping on edits.
  React.useEffect(() => {
    if (filled.current || !spoken) return;
    filled.current = true;
    setForm((f) => ({
      ...f,
      firstName: spoken.firstName ?? "",
      lastName: spoken.lastName ?? "",
      mobile: spoken.mobile ?? "",
      email: spoken.email ?? "",
      address: spoken.address ?? "",
      suburb: spoken.suburb ?? "",
    }));
  }, [spoken]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const nullIfEmpty = (v: string) => (v.trim() ? v.trim() : null);

  const run = (input: Parameters<typeof setCustomer.mutateAsync>[0]) => {
    setError(null);
    setCustomer
      .mutateAsync(input)
      .then((r) => onDone?.(r.name))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const pick = (contactId: number) => run({ id: quoteId, contactId });

  const saidSomething = Boolean(spoken && (spoken.name || spoken.mobile || spoken.email));
  const said = spoken ? [spoken.name, spoken.mobile, spoken.email].filter(Boolean).join(" · ") : "";
  const busy = setCustomer.isPending;

  return (
    <div className="rounded-md border-2 border-[var(--gold)]/50 bg-[var(--gold-wash)] px-3 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <UserX className="size-4 shrink-0 text-[var(--gold-deep)]" />
        {saidSomething ? "Customer not found" : "No customer on this quote yet"}
      </p>
      {saidSomething ? (
        <p className="mt-0.5 text-xs text-muted-foreground">
          You said <span className="font-medium text-foreground">{said}</span>.{" "}
          {spoken?.isNew ? "You said they are new." : "Nobody in the system matched for sure."}
        </p>
      ) : null}

      {help.isLoading ? <p className="mt-2 text-xs text-muted-foreground">Looking for matches…</p> : null}

      {candidates.length ? (
        <div className="mt-3">
          <Label>Is it one of these?</Label>
          <div className="space-y-1.5">
            {candidates.map((c) => (
              <ChoiceButton key={c.id} row={c} disabled={busy} onPick={pick} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-3">
        <Label>{candidates.length ? "Or create them as a new client" : "Create a new client"}</Label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>First name</Label>
            <Input value={form.firstName} onChange={set("firstName")} />
          </div>
          <div>
            <Label>Last name</Label>
            <Input value={form.lastName} onChange={set("lastName")} />
          </div>
          <div>
            <Label>Mobile</Label>
            <Input value={form.mobile} onChange={set("mobile")} inputMode="tel" />
          </div>
          <div>
            <Label>Email</Label>
            <Input value={form.email} onChange={set("email")} inputMode="email" />
          </div>
          <div className="col-span-2">
            <Label>Street address</Label>
            <Input value={form.address} onChange={set("address")} />
          </div>
          <div>
            <Label>Suburb</Label>
            <Input value={form.suburb} onChange={set("suburb")} />
          </div>
          <div>
            <Label>Postcode</Label>
            <Input value={form.postcode} onChange={set("postcode")} inputMode="numeric" />
          </div>
          <div className="col-span-2">
            <Button
              disabled={!form.firstName.trim() || busy}
              onClick={() =>
                run({
                  id: quoteId,
                  create: {
                    firstName: form.firstName.trim(),
                    lastName: form.lastName.trim(),
                    mobile: nullIfEmpty(form.mobile),
                    email: nullIfEmpty(form.email),
                    address: nullIfEmpty(form.address),
                    suburb: nullIfEmpty(form.suburb),
                    postcode: nullIfEmpty(form.postcode),
                  },
                })
              }
            >
              <UserPlus className="size-4" />
              {busy ? "Saving…" : "Create client and add to quote"}
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <Label>Someone else already in the system</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Name, mobile or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {q.length >= 2 ? (
          <div className="mt-2">
            <ClientSearch q={q} disabled={busy} onPick={pick} />
          </div>
        ) : null}
      </div>

      {error ? <p className="mt-2 text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
