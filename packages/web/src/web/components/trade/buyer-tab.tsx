import * as React from "react";
import { Link, useLocation } from "wouter";
import { BadgeCheck, FileUp, Plus, ShieldAlert } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../ui/field";
import {
  useAddAgreement,
  useAgreements,
  useAgreementUrl,
  useArchiveAgreement,
  useBuyerCard,
  useCreateDraft,
  useSaveBuyer,
  useTradeSettings,
  useVerifyEntity,
} from "../../queries/trade";
import { ErrorLine, OffsetBadge, SaleState, TRADE_CATEGORIES, auDate, errText, fileToUpload, m2, todayYmd } from "./shared";

type Kind = "installer" | "contact" | "company";

/**
 * The trade part of a contact, company or installer card. Admin only: the
 * server refuses anyone else, and the cards only render this for Admin.
 * A buyer is the existing card with a tick. No copy of the card is made.
 */
export function BuyerTradeTab({ kind, refId }: { kind: Kind; refId: number }) {
  const card = useBuyerCard(kind, refId);
  const settings = useTradeSettings();
  const save = useSaveBuyer();
  const create = useCreateDraft();
  const [, navigate] = useLocation();
  const [form, setForm] = React.useState<{
    active: boolean;
    categories: string[];
    creditApproved: boolean;
    termsDays: number;
    feePresentation: "itemised" | "combined";
    notes: string;
  } | null>(null);

  const buyer = card.data?.buyer ?? null;
  React.useEffect(() => {
    if (!card.data) return;
    const b = card.data.buyer;
    setForm({
      active: b?.active ?? true,
      categories: b?.categories ?? [],
      creditApproved: b?.creditApproved ?? false,
      termsDays: b?.termsDays ?? 0,
      feePresentation: (b?.feePresentation as "itemised" | "combined") ?? "itemised",
      notes: b?.notes ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once per card
  }, [card.data?.buyer?.id, card.isFetched]);

  if (card.isLoading || !form) return <Loading />;
  if (card.error) return <ErrorLine error={card.error} />;
  const on = settings.data?.enabled ?? false;

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm({ ...form, [k]: v });

  return (
    <div className="flex flex-col gap-4">
      {!on ? (
        <p className="rounded-md border border-border bg-secondary px-3 py-2 text-sm text-muted-foreground">
          Trade sales is switched off. Records stay readable. New sales and new buyers are paused.
        </p>
      ) : null}

      <Card>
        <CardHeader
          title={buyer ? "Trade buyer" : "Not a trade buyer"}
          subtitle={buyer ? `Owing ${m2(card.data!.owing)}${card.data!.creditBalance > 0 ? `. Credit balance ${m2(card.data!.creditBalance)}` : ""}` : "Tick to let Terra sell materials to this card."}
          action={
            buyer && on ? (
              <Button
                size="sm"
                disabled={create.isPending || !buyer.active}
                onClick={async () => {
                  const saleId = await create.mutateAsync({ buyerId: buyer.id, settleBy: "pay" });
                  navigate(`/finance/trade/${saleId}`);
                }}
              >
                <Plus className="size-4" />
                New sale
              </Button>
            ) : null
          }
        />
        <div className="flex flex-col gap-3 p-4">
          <label htmlFor="trade_cb1" className="flex items-center gap-2 text-sm">
            <Checkbox id="trade_cb1" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
            Trade buyer
          </label>
          <div>
            <p className="label-xs mb-1">Categories this buyer may buy</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {TRADE_CATEGORIES.map((c) => (
                <label key={c.name} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={form.categories.includes(c.name)}
                    onChange={(e) => set("categories", e.target.checked ? [...form.categories, c.name] : form.categories.filter((x) => x !== c.name))}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Credit" hint={buyer?.creditApproved && buyer.creditApprovedByName ? `Approved by ${buyer.creditApprovedByName} ${auDate(buyer.creditApprovedAt)}` : undefined}>
              <Select
                value={form.creditApproved ? "yes" : "no"}
                onChange={(e) => {
                  const yes = e.target.value === "yes";
                  setForm({ ...form, creditApproved: yes, termsDays: yes ? form.termsDays || 7 : 0 });
                }}
              >
                <option value="no">Not approved: pays before collection</option>
                <option value="yes">Credit approved</option>
              </Select>
            </Field>
            <Field label="Terms (days)">
              <Input type="number" min={0} max={90} disabled={!form.creditApproved} value={form.termsDays} onChange={(e) => set("termsDays", Number(e.target.value) || 0)} />
            </Field>
            <Field label="Fees on the invoice" hint="Layout only. The totals are the same.">
              <Select value={form.feePresentation} onChange={(e) => set("feePresentation", e.target.value as "itemised" | "combined")}>
                <option value="itemised">Itemised under each product</option>
                <option value="combined">One "Freight and levies" line</option>
              </Select>
            </Field>
          </div>
          <Field label="Notes">
            <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={save.isPending || (!buyer && !on)} onClick={() => save.mutate({ kind, refId, ...form })}>
              {save.isPending ? <Spinner /> : null}
              Save trade settings
            </Button>
            {save.isSuccess ? <span className="text-xs text-[var(--success)]">Saved</span> : null}
          </div>
          <ErrorLine error={save.error} />
        </div>
      </Card>

      {buyer && kind === "installer" ? <EntityCard buyer={buyer} /> : null}
      {buyer && kind === "installer" ? <AgreementsCard installerId={refId} /> : null}

      {buyer ? (
        <Card>
          <CardHeader title="Trade sales" subtitle="Last price sold shows on the sale screen as a reference only." />
          {card.data!.sales.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="th px-4 py-2 text-left">Invoice</th>
                  <th className="th px-4 py-2 text-left">Date</th>
                  <th className="th px-4 py-2 text-right">Total</th>
                  <th className="th px-4 py-2 text-right">Owing</th>
                  <th className="th px-4 py-2 text-left">State</th>
                </tr>
              </thead>
              <tbody>
                {card.data!.sales.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      <Link href={`/finance/trade/${s.id}`} className="font-medium text-[var(--gold-deep)] hover:underline">
                        {s.invoiceRef ?? s.ref}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{auDate(s.finalisedAt ?? s.createdAt)}</td>
                    <td className="tabular px-4 py-2 text-right">{m2(s.total)}</td>
                    <td className={`tabular px-4 py-2 text-right ${s.money.balance < -0.005 ? "text-destructive" : ""}`}>{m2(s.money.balance)}</td>
                    <td className="px-4 py-2">
                      <span className="flex flex-wrap gap-1">
                        <SaleState state={s.money.state} />
                        <OffsetBadge status={s.offsetState} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No trade sales yet.</Empty>
          )}
        </Card>
      ) : null}
    </div>
  );
}

type Buyer = NonNullable<NonNullable<ReturnType<typeof useBuyerCard>["data"]>["buyer"]>;

/** Same entity check. Offsets need it. Typing an ABN never verifies it, and a changed ABN clears it. */
function EntityCard({ buyer }: { buyer: Buyer }) {
  const verify = useVerifyEntity();
  return (
    <Card>
      <CardHeader title="Same entity check" subtitle="Needed before any materials offset against this installer's bills." />
      <div className="flex flex-col gap-2 p-4 text-sm">
        <p>
          ABN on the installer card: <span className="tabular font-medium">{buyer.abn || "none"}</span>
        </p>
        {buyer.entityOk ? (
          <p className="flex items-center gap-1.5 text-[var(--success)]">
            <BadgeCheck className="size-4" />
            Verified ABN {buyer.entityAbn} by {buyer.entityVerifiedByName}, {auDate(buyer.entityVerifiedAt)}
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-[var(--warning)]">
            <ShieldAlert className="size-4" />
            {buyer.entityAbn ? "The ABN changed since it was verified. Verify again." : "Not verified. No offsets until it is."}
          </p>
        )}
        <div>
          <Button size="sm" variant="outline" disabled={!buyer.abn || verify.isPending} onClick={() => verify.mutate({ buyerId: buyer.id })}>
            Verify same entity
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Press this only when you have checked the business that bills Terra for labour is the same business buying the materials.
        </p>
        <ErrorLine error={verify.error} />
      </div>
    </Card>
  );
}

function AgreementsCard({ installerId }: { installerId: number }) {
  const list = useAgreements(installerId);
  const add = useAddAgreement();
  const archive = useArchiveAgreement();
  const url = useAgreementUrl();
  const [signed, setSigned] = React.useState(todayYmd());
  const [until, setUntil] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <Card>
      <CardHeader title="Agreements" subtitle="Signed standing materials offset agreements. A typed note alone never counts." />
      <div className="flex flex-col gap-3 p-4">
        {list.isLoading ? <Loading /> : null}
        {list.data?.length ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {list.data.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <button type="button" className="font-medium text-[var(--gold-deep)] hover:underline" onClick={async () => window.open((await url.mutateAsync({ id: a.id })).url, "_blank")}>
                  {a.filename}
                </button>
                <span className="text-muted-foreground">
                  signed {auDate(a.signedDate)}
                  {a.validUntil ? `, until ${auDate(a.validUntil)}` : ""}
                </span>
                {a.archivedAt ? <Badge>Archived</Badge> : a.inDate ? <Badge colour="#2E6B4F">In date</Badge> : <Badge colour="#B23B2C">Out of date</Badge>}
                {!a.archivedAt ? (
                  <Button size="sm" variant="ghost" onClick={() => archive.mutate({ id: a.id })}>
                    Archive
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : !list.isLoading ? (
          <p className="text-sm text-muted-foreground">No agreements on file.</p>
        ) : null}
        <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-3">
          <Field label="Signed">
            <Input type="date" value={signed} onChange={(e) => setSigned(e.target.value)} />
          </Field>
          <Field label="Valid until (optional)">
            <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </Field>
          <Field label="Signed file">
            <Input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={!file || add.isPending}
            onClick={async () => {
              setErr(null);
              try {
                await add.mutateAsync({ installerId, title: "Standing materials offset agreement", signedDate: signed, validUntil: until || null, note: "", file: await fileToUpload(file!) });
                setFile(null);
              } catch (e) {
                setErr(errText(e));
              }
            }}
          >
            {add.isPending ? <Spinner /> : <FileUp className="size-4" />}
            Add agreement
          </Button>
          {err ? <p className="mt-2 text-sm text-destructive">{err}</p> : null}
        </div>
      </div>
    </Card>
  );
}
