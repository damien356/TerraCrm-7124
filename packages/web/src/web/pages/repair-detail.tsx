import * as React from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, ExternalLink, MessageSquare, Pencil, Send } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { errorText } from "../components/public-shell";
import { useBootstrap } from "../queries/settings";
import { useApproveRepair, useRepair, useResendRepair, useSetRepairPrice, useTimberPreview } from "../queries/timber";
import { REPAIR_STATUS_COLOUR } from "./repairs";

/**
 * ONE TIMBER REPAIR (spec 14 Oct, Part B, notes 18.38). The photos Marc saw,
 * the client, Marc's price and the client price, and the quote wording.
 * Approve emails the quote with accept, sign and pay. Edit opens the quote.
 * Text Marc again sends a fresh 14 day link. Set price is for when Marc rang.
 */

const money = (n: number | null | undefined) =>
  n == null ? "-" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (d: Date | string | null | undefined) =>
  d
    ? new Date(d).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Australia/Brisbane" })
    : "-";

const GONE = new Set(["sent", "accepted", "offered"]);
const CAN_RESEND = new Set(["new", "asked", "not_sent", "see"]);

export default function RepairDetailPage() {
  const { id: raw = "" } = useParams<{ id: string }>();
  const id = Number(raw);
  const repair = useRepair(Number.isFinite(id) ? id : null);
  const bootstrap = useBootstrap();
  const canSeeCosts = !!bootstrap.data?.actor.canSeeCosts;
  const approve = useApproveRepair();
  const resend = useResendRepair();
  const [priceOpen, setPriceOpen] = React.useState(false);
  const [photo, setPhoto] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);

  if (repair.isLoading) return <Loading />;
  if (repair.error || !repair.data) {
    return (
      <Page title="Timber repair">
        <Card>
          <Empty>{errorText(repair.error ?? "That repair is not there any more.")}</Empty>
        </Card>
      </Page>
    );
  }
  const r = repair.data;
  const q = r.quote;
  const canApprove = !!q && r.status === "quoted";
  const canPrice = canSeeCosts && !GONE.has(r.status);

  async function doApprove() {
    setMessage(null);
    try {
      const out = await approve.mutateAsync({ id });
      setMessage({ ok: true, text: `Quote ${out.ref} emailed to ${out.to}.` });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    }
  }
  async function doResend() {
    setMessage(null);
    try {
      await resend.mutateAsync({ id });
      setMessage({ ok: true, text: "Marc has been texted a fresh link." });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    }
  }

  return (
    <Page
      title={`Timber repair${r.job ? ` #${r.job.ref}` : ""}`}
      subtitle={[r.repairTypeLabel, r.suburb].filter(Boolean).join(", ")}
      actions={
        <Link to="/repairs">
          <Button size="sm" variant="ghost">
            <ArrowLeft className="size-4" /> All repairs
          </Button>
        </Link>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge colour={REPAIR_STATUS_COLOUR[r.status] ?? null}>{r.statusLabel}</Badge>
        {canApprove ? (
          <Button size="sm" onClick={doApprove} disabled={approve.isPending}>
            <Send className="size-4" /> {approve.isPending ? "Sending…" : "Approve and send"}
          </Button>
        ) : null}
        {q ? (
          <Link to={`/quotes/${q.id}`}>
            <Button size="sm" variant="outline">
              <Pencil className="size-4" /> Edit quote
            </Button>
          </Link>
        ) : null}
        {CAN_RESEND.has(r.status) ? (
          <Button size="sm" variant="outline" onClick={doResend} disabled={resend.isPending}>
            <MessageSquare className="size-4" /> {resend.isPending ? "Texting…" : "Text Marc again"}
          </Button>
        ) : null}
        {canPrice ? (
          <Button size="sm" variant="outline" onClick={() => setPriceOpen(true)}>
            Set price
          </Button>
        ) : null}
      </div>
      {message ? (
        <p className={`mb-4 rounded-md px-3 py-2 text-sm ${message.ok ? "bg-[#2F7A4B1A] text-[#2F7A4B]" : "bg-destructive/10 text-destructive"}`}>{message.text}</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Photos" subtitle={`${r.photos.length} photo${r.photos.length === 1 ? "" : "s"} from the client. Marc sees the same ones.`} />
            {r.photos.length === 0 ? (
              <Empty>No photos on the job.</Empty>
            ) : (
              <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3">
                {r.photos.map((p) => (
                  <button key={p.id} type="button" onClick={() => setPhoto(p.url)} className="aspect-square overflow-hidden rounded-md bg-secondary">
                    <img src={p.url} alt="Damage from the client" className="size-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              title="The quote"
              subtitle={q ? `${q.ref}, ${q.status}${q.sentAt ? `, sent ${when(q.sentAt)}` : ""}` : "Made when Marc replies with a price."}
              action={
                q ? (
                  <Link to={`/quotes/${q.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                    Open <ExternalLink className="size-3" />
                  </Link>
                ) : undefined
              }
            />
            {q ? (
              <div className="space-y-2 px-4 pb-4 text-sm">
                {q.title ? <p className="font-medium">{q.title}</p> : null}
                <p className="whitespace-pre-line text-muted-foreground">{q.wording || "No wording on the quote."}</p>
                <p className="tabular font-semibold">{money(q.total)} incl GST</p>
              </div>
            ) : (
              <Empty>No quote yet.</Empty>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Prices" />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 pb-4 text-sm">
              {canSeeCosts ? (
                <>
                  <dt className="text-muted-foreground">Marc's price</dt>
                  <dd className="tabular">{r.marcPrice == null ? "Not priced yet" : `${money(r.marcPrice)} ex GST`}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Client price</dt>
              <dd className="tabular">{r.clientPrice == null ? "-" : `${money(r.clientPrice)} incl GST`}</dd>
              {r.marcNote ? (
                <>
                  <dt className="text-muted-foreground">Marc's note</dt>
                  <dd>{r.marcNote}</dd>
                </>
              ) : null}
              {r.lastReply ? (
                <>
                  <dt className="text-muted-foreground">Last reply</dt>
                  <dd className="break-words">"{r.lastReply}"</dd>
                </>
              ) : null}
              {canSeeCosts && r.smsCost != null ? (
                <>
                  <dt className="text-muted-foreground">Texts</dt>
                  <dd className="tabular">
                    {r.smsCount} ({money(r.smsCost)})
                  </dd>
                </>
              ) : null}
            </dl>
          </Card>

          <Card>
            <CardHeader title="The repair" />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 pb-4 text-sm">
              <dt className="text-muted-foreground">Type</dt>
              <dd>{r.repairTypeLabel}</dd>
              <dt className="text-muted-foreground">Area</dt>
              <dd>{r.area || "-"}</dd>
              <dt className="text-muted-foreground">Floor</dt>
              <dd>{r.floorType}</dd>
              <dt className="text-muted-foreground">Suburb</dt>
              <dd>{r.suburb || "-"}</dd>
              <dt className="text-muted-foreground">Asked</dt>
              <dd>{r.installer ? `${r.installer.name}, ${when(r.askedAt)}` : when(r.askedAt)}</dd>
              <dt className="text-muted-foreground">Replied</dt>
              <dd>{when(r.repliedAt)}</dd>
              <dt className="text-muted-foreground">Link ends</dt>
              <dd>{when(r.expiresAt)}</dd>
            </dl>
          </Card>

          <Card>
            <CardHeader title="Client" />
            {r.client ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 pb-4 text-sm">
                <dt className="text-muted-foreground">Name</dt>
                <dd>{r.client.name || "-"}</dd>
                <dt className="text-muted-foreground">Mobile</dt>
                <dd>{r.client.mobile ? <a href={`tel:${r.client.mobile}`} className="text-primary hover:underline">{r.client.mobile}</a> : "-"}</dd>
                <dt className="text-muted-foreground">Email</dt>
                <dd className="break-all">{r.client.email || "-"}</dd>
              </dl>
            ) : (
              <Empty>No client on the job.</Empty>
            )}
            {r.job ? (
              <div className="border-t border-border px-4 py-2.5">
                <Link to={`/jobs/${r.job.id}`} className="text-sm font-medium text-primary hover:underline">
                  Open job #{r.job.ref}
                </Link>
              </div>
            ) : null}
          </Card>
        </div>
      </div>

      <SetPriceModal open={priceOpen} id={id} current={r.marcPrice} onClose={() => setPriceOpen(false)} onDone={(text) => setMessage({ ok: true, text })} />
      <Modal open={!!photo} onClose={() => setPhoto(null)} title="Photo" width="max-w-4xl">
        {photo ? <img src={photo} alt="Damage from the client, full size" className="mx-auto max-h-[75vh] w-auto rounded-md" /> : null}
      </Modal>
    </Page>
  );
}

function SetPriceModal({ open, id, current, onClose, onDone }: { open: boolean; id: number; current: number | null; onClose: () => void; onDone: (text: string) => void }) {
  const [price, setPrice] = React.useState("");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const save = useSetRepairPrice();
  React.useEffect(() => {
    if (open) {
      setPrice(current != null ? String(current) : "");
      setNote("");
      setError(null);
    }
  }, [open, current]);
  const n = Number(price);
  const valid = price.trim() !== "" && Number.isFinite(n) && n > 0;
  const preview = useTimberPreview(valid ? n : null);

  async function submit() {
    setError(null);
    if (!valid) return setError("Type Marc's price ex GST.");
    try {
      const out = await save.mutateAsync({ id, marcPrice: n, note });
      onDone(out.autoSent ? `Priced and sent to the client at ${money(out.clientPrice)} incl GST.` : `Quote ready at ${money(out.clientPrice)} incl GST. Check it, then Approve.`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set Marc's price"
      subtitle="For when Marc rang or texted somewhere else. Makes or updates the draft quote."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save price"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Marc's price, ex GST">
          <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="350" />
        </Field>
        <Field label="Note" hint="Optional. Goes on the repair, not the quote.">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {valid && preview.data ? (
          <p className="rounded-md bg-secondary px-3 py-2 text-sm">
            Client price <span className="tabular font-semibold">{money(preview.data.total)}</span> incl GST.
          </p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}
