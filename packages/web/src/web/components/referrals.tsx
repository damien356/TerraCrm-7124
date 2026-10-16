import * as React from "react";
import { Link } from "wouter";
import { AlertTriangle, Handshake } from "lucide-react";
import { Card, CardHeader, Empty, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select } from "./ui/field";
import { money, moneyExact, shortDate } from "../lib/money";
import { useJobReferral, useReferrerCard, useReferrerPickList, useSaveReferrerCard, useSetJobReferral } from "../queries/referrals";

/* ---------------------------------------------------------------------------
 * REFERRAL FEES (notes 18.47).
 *  - ReferrerSection: the "Also a referrer" tick on a company or client card.
 *    Admin only. The caller checks the role; the API checks it again.
 *  - JobReferrerCard: who referred a job. Office picks the name. Only an
 *    Admin sees the rate, the fee and why it is blocked.
 *  - ReferralFeeRows: the fee as its own line on the Admin's quote totals.
 * ------------------------------------------------------------------------- */

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

export const FEE_STATUS_COLOUR: Record<string, string> = {
  open: "#7A736D",
  owed: "#C05A2B",
  flagged: "#D08A1E",
  paid: "#3F7D3A",
  no_fee: "#7A736D",
};

type CardForm = {
  active: boolean;
  ratePercent: string;
  abn: string;
  gstRegistered: boolean;
  bankAccountName: string;
  bankBsb: string;
  bankAccountNumber: string;
  remittanceEmail: string;
};

const EMPTY_FORM: CardForm = {
  active: false,
  ratePercent: "5",
  abn: "",
  gstRegistered: true,
  bankAccountName: "",
  bankBsb: "",
  bankAccountNumber: "",
  remittanceEmail: "",
};

/** The "Also a referrer" section, with both sides and their referred jobs. Admin only. */
export function ReferrerSection({ companyId, contactId, abn }: { companyId?: number; contactId?: number; abn?: string | null }) {
  const key = companyId != null ? { companyId } : { contactId };
  const card = useReferrerCard(key);
  const save = useSaveReferrerCard();
  const [form, setForm] = React.useState<CardForm>(EMPTY_FORM);
  const [dirty, setDirty] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const ref = card.data?.referrer ?? null;

  React.useEffect(() => {
    if (dirty || card.isLoading) return;
    setForm(
      ref
        ? {
            active: ref.active,
            ratePercent: String(ref.ratePercent),
            abn: ref.abn ?? "",
            gstRegistered: ref.gstRegistered,
            bankAccountName: ref.bankAccountName ?? "",
            bankBsb: ref.bankBsb ?? "",
            bankAccountNumber: ref.bankAccountNumber ?? "",
            remittanceEmail: ref.remittanceEmail ?? "",
          }
        : { ...EMPTY_FORM, abn: abn ?? "" },
    );
  }, [ref, dirty, card.isLoading, abn]);

  function set<K extends keyof CardForm>(k: K, v: CardForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
    setMsg(null);
  }

  async function submit(next: CardForm) {
    setMsg(null);
    const rate = Number(next.ratePercent);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return setMsg({ ok: false, text: "Type a rate from 0 to 100." });
    try {
      const r = await save.mutateAsync({
        key,
        fields: {
          active: next.active,
          ratePercent: rate,
          abn: next.abn || null,
          gstRegistered: next.gstRegistered,
          bankAccountName: next.bankAccountName || null,
          bankBsb: next.bankBsb || null,
          bankAccountNumber: next.bankAccountNumber || null,
          remittanceEmail: next.remittanceEmail || null,
        },
      });
      setDirty(false);
      setMsg({ ok: true, text: r.recalced ? `Saved. ${r.recalced} draft ${r.recalced === 1 ? "quote" : "quotes"} updated.` : "Saved." });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }

  const sides = card.data?.sides ?? null;
  const on = form.active;

  return (
    <Card>
      <CardHeader
        title="Also a referrer"
        subtitle="Admin only. Office never sees the rate, the fees or the bank details."
        action={card.isLoading ? <Spinner /> : ref && ref.active ? <Badge colour="#3F7D3A">Referrer</Badge> : null}
      />
      <div className="flex flex-col gap-3 px-4 py-3">
        <label htmlFor={`referrer-tick-${companyId ?? "c"}-${contactId ?? "p"}`} className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            id={`referrer-tick-${companyId ?? "c"}-${contactId ?? "p"}`}
            checked={on}
            aria-label="Also a referrer"
            onChange={(e) => {
              const next = { ...form, active: e.target.checked };
              setForm(next);
              // Taking the tick off saves straight away, so their open jobs stop carrying a fee.
              if (!e.target.checked && ref?.active) void submit(next);
              else setDirty(true);
            }}
          />
          <span className="font-medium">Also a referrer</span>
          <span className="text-xs text-muted-foreground">Sends work our way for a fee</span>
        </label>

        {on ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Default rate %" hint="On the price ex GST. Any job can be changed.">
              <Input inputMode="decimal" value={form.ratePercent} onChange={(e) => set("ratePercent", e.target.value)} />
            </Field>
            <Field label="ABN">
              <Input value={form.abn} onChange={(e) => set("abn", e.target.value)} />
            </Field>
            <label htmlFor={`referrer-gst-${companyId ?? "c"}-${contactId ?? "p"}`} className="flex cursor-pointer items-center gap-2 text-sm sm:col-span-2">
              <Checkbox id={`referrer-gst-${companyId ?? "c"}-${contactId ?? "p"}`} checked={form.gstRegistered} onChange={(e) => set("gstRegistered", e.target.checked)} />
              GST registered (their invoice adds GST)
            </label>
            <Field label="Account name">
              <Input value={form.bankAccountName} onChange={(e) => set("bankAccountName", e.target.value)} />
            </Field>
            <Field label="BSB">
              <Input inputMode="numeric" placeholder="000-000" value={form.bankBsb} onChange={(e) => set("bankBsb", e.target.value)} />
            </Field>
            <Field label="Account number">
              <Input inputMode="numeric" value={form.bankAccountNumber} onChange={(e) => set("bankAccountNumber", e.target.value)} />
            </Field>
            <Field label="Remittance email">
              <Input type="email" value={form.remittanceEmail} onChange={(e) => set("remittanceEmail", e.target.value)} />
            </Field>
          </div>
        ) : null}

        {dirty ? (
          <div>
            <Button size="sm" onClick={() => void submit(form)} disabled={save.isPending}>
              {save.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
              Save referrer details
            </Button>
          </div>
        ) : null}
        {msg ? <p className={msg.ok ? "text-xs text-[var(--success)]" : "text-xs text-destructive"}>{msg.text}</p> : null}
      </div>

      {sides ? (
        <>
          <div className="grid grid-cols-2 gap-3 border-t border-border px-4 py-3 text-sm">
            <div>
              <p className="label-xs">They paid Terra</p>
              <p className="tabular mt-0.5 font-semibold">{money(sides.theyPaid.paid)}</p>
              <p className="tabular text-xs text-muted-foreground">of {money(sides.theyPaid.invoiced)} invoiced</p>
            </div>
            <div>
              <p className="label-xs">Fees to them (ex GST)</p>
              <p className="tabular mt-0.5 font-semibold">{money(sides.fees.paid)} paid</p>
              <p className="tabular text-xs text-muted-foreground">
                {money(sides.fees.owed)} owed{sides.fees.flagged ? `, ${sides.fees.flagged} to decide` : ""}
              </p>
            </div>
            <div className="col-span-2">
              <p className="label-xs">Work they referred</p>
              <p className="tabular mt-0.5 font-semibold">{money(sides.referredValue)}</p>
            </div>
          </div>
          <div className="border-t border-border">
            <p className="label-xs px-4 pt-3">Referred jobs</p>
            {sides.jobs.length === 0 ? (
              <p className="px-4 pb-3 pt-1 text-xs text-muted-foreground">No jobs referred yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {sides.jobs.map((j) => (
                  <li key={j.jobId} className="flex items-start justify-between gap-3 px-4 py-2">
                    <div className="min-w-0">
                      <Link to={`/jobs/${j.jobId}`} className="text-sm font-medium text-primary hover:underline">
                        {j.ref}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {j.title} {j.status ? `· ${j.status}` : ""} · {money(j.value)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <Badge colour={FEE_STATUS_COLOUR[j.feeStatus]}>{j.feeStatusLabel}</Badge>
                      <p className="tabular mt-0.5 text-xs text-muted-foreground">
                        {j.amount ? moneyExact(j.amount) : j.rate}
                        {j.paidOn ? ` · ${shortDate(j.paidOn)}` : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </Card>
  );
}

/** Who referred the job. Office sees and picks the name. An Admin also sets the rate for this job. */
export function JobReferrerCard({ jobId, isAdmin }: { jobId: number; isAdmin: boolean }) {
  const q = useJobReferral(jobId);
  const set = useSetJobReferral();
  const [editing, setEditing] = React.useState(false);
  const picks = useReferrerPickList(editing);
  const [picked, setPicked] = React.useState("");
  const [rateOpen, setRateOpen] = React.useState(false);
  const [feeType, setFeeType] = React.useState<"default" | "percent" | "fixed">("default");
  const [feeValue, setFeeValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const d = q.data;

  const curId = d?.referrerId ?? null;
  const curType = d?.admin?.feeType ?? null;
  const curValue = d?.admin?.feeValue ?? null;
  React.useEffect(() => {
    setPicked(curId ? String(curId) : "");
    if (curType) {
      setFeeType(curType);
      setFeeValue(curValue != null ? String(curValue) : "");
    }
  }, [curId, curType, curValue]);

  if (!d || !d.show) return null;

  async function savePick(referrerId: number | null) {
    setError(null);
    try {
      await set.mutateAsync({ jobId, referrerId });
      setEditing(false);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function saveRate() {
    setError(null);
    const value = feeType === "default" ? null : Number(feeValue);
    if (value != null && (!Number.isFinite(value) || value < 0)) return setError("Type a number.");
    try {
      await set.mutateAsync({ jobId, referrerId: d!.referrerId, feeType, feeValue: value });
      setRateOpen(false);
    } catch (e) {
      setError(errText(e));
    }
  }

  const a = d.admin;

  return (
    <Card>
      <CardHeader
        title="Referrer"
        subtitle={isAdmin ? "Who referred this job, and their fee." : "Who referred this job."}
        action={
          !editing && !d.locked ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {d.referrerId ? "Change" : "Add"}
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-3 px-4 py-3.5 text-sm">
        {editing ? (
          <div className="space-y-3">
            <Select value={picked} aria-label="Referrer" onChange={(e) => setPicked(e.target.value)}>
              <option value="">Pick the referrer</option>
              {(picks.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {picks.data && picks.data.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nobody is ticked as a referrer yet. An Admin ticks "Also a referrer" on their card.</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void savePick(picked ? Number(picked) : null)} disabled={set.isPending || !picked}>
                {set.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              {d.referrerId ? (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void savePick(null)} disabled={set.isPending}>
                  Take off
                </Button>
              ) : null}
            </div>
          </div>
        ) : d.name ? (
          <p className="flex items-center gap-2 font-medium">
            <Handshake className="size-4 text-muted-foreground" />
            {d.name}
          </p>
        ) : (
          <p className="text-muted-foreground">The source is Referral. Press Add to pick who referred it.</p>
        )}

        {isAdmin && a ? (
          <div className="rounded-md bg-secondary/60 px-3 py-2 text-[13px]">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{a.label}</p>
              <Badge colour={FEE_STATUS_COLOUR[a.status]}>{a.statusLabel}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {a.feeType === "default" ? `Card rate ${a.defaultRate}%.` : `Set for this job: ${a.rate}.`} Ex GST, on top of the price.
              {a.paidOn ? ` Paid ${shortDate(a.paidOn)}.` : ""}
            </p>
            {a.blockedReason ? (
              <p className="mt-1.5 flex items-start gap-1.5 text-xs text-[var(--warning)]">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {a.blockedReason}
              </p>
            ) : null}
            {a.flagReason ? <p className="mt-1.5 text-xs text-[var(--warning)]">{a.flagReason}</p> : null}
            {a.status === "open" ? (
              rateOpen ? (
                <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_120px]">
                  <Select value={feeType} aria-label="Fee for this job" onChange={(e) => setFeeType(e.target.value as typeof feeType)}>
                    <option value="default">Card rate ({a.defaultRate}%)</option>
                    <option value="percent">A different %</option>
                    <option value="fixed">A fixed $ amount</option>
                  </Select>
                  {feeType !== "default" ? (
                    <Input
                      inputMode="decimal"
                      aria-label={feeType === "percent" ? "Rate %" : "Amount ex GST"}
                      placeholder={feeType === "percent" ? "%" : "$ ex GST"}
                      value={feeValue}
                      onChange={(e) => setFeeValue(e.target.value)}
                    />
                  ) : null}
                  <div className="flex gap-2 sm:col-span-2">
                    <Button size="sm" onClick={() => void saveRate()} disabled={set.isPending}>
                      Save rate
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRateOpen(false)}>
                      Cancel
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground sm:col-span-2">0 means no fee on this job. Draft quotes update now. Sent and accepted quotes keep their price until a re-quote.</p>
                </div>
              ) : (
                <button type="button" className="mt-1.5 text-xs font-medium text-primary hover:underline" onClick={() => setRateOpen(true)}>
                  Change the fee for this job
                </button>
              )
            ) : null}
          </div>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Card>
  );
}

/** The fee as its own line on the Admin's quote or variation totals. Office and clients get it spread into the lines. */
export function ReferralFeeRows({ fee, subtotal }: { fee: { label: string; amount: number; blockedReason: string | null } | null | undefined; subtotal: number }) {
  if (!fee) return null;
  return (
    <>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Lines</span>
        <span className="tabular">{money(subtotal - fee.amount)}</span>
      </div>
      <div className="flex justify-between gap-3" title="Admin only. Spread into the lines on the client copy.">
        <span className="text-[var(--gold-ink,#8A6A2F)]">{fee.label}</span>
        <span className="tabular whitespace-nowrap">{money(fee.amount)}</span>
      </div>
      {fee.blockedReason ? <p className="text-xs text-[var(--warning)]">{fee.blockedReason}</p> : null}
    </>
  );
}

export function NoReferrers() {
  return <Empty>Nobody is ticked as a referrer yet. Tick "Also a referrer" on a company or client card.</Empty>;
}
