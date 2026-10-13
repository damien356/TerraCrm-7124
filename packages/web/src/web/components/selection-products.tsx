import * as React from "react";
import { Check, Layers, Lock, Palette } from "lucide-react";
import { Button } from "./ui/button";
import { Field, Input, Textarea } from "./ui/field";
import { Spinner } from "./ui/card";
import { Modal } from "./ui/modal";
import { PublicCard, PublicMessage, PublicShell, errorText } from "./public-shell";
import { moneyExact } from "../lib/money";
import { usePublicSelection, useSubmitSelection } from "../queries/publicPages";

/**
 * /m/<token>, the new kind (fix list 13 Oct, item 8): one section per product
 * on the accepted quote. Each shows the quoted colour with its swatch, and
 * "Thinking about a different colour? Change it here" opens the other colours
 * of the SAME range. One notes box at the bottom. Prices only show when the
 * server says this person may see them.
 */

type Data = NonNullable<ReturnType<typeof usePublicSelection>["data"]>;
type Section = Data["sections"][number];
type Option = Section["options"][number];
type Upgrade = Data["upgrades"][number];

/** Item 9: "Upgrade to Gold underlay for an extra $X". One tap, Yes or No. */
function UpgradeCard({
  u,
  answer,
  locked,
  onAnswer,
}: {
  u: Upgrade;
  answer: "" | "yes" | "no";
  locked: boolean;
  onAnswer: (a: "yes" | "no") => void;
}) {
  const fixed = locked || u.settled;
  return (
    <PublicCard>
      <div className="flex gap-4">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-[var(--gold)]/15 text-[var(--gold-deep)]">
          <Layers className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="label-xs">Underlay upgrade</p>
          <h2 className="text-lg font-bold leading-tight tracking-[-0.01em]">
            {u.settled ? (
              <>Upgraded to {u.toName}</>
            ) : (
              <>
                Upgrade to {u.toName} for an extra {moneyExact(u.extraIncGst)} inc GST?
              </>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your quote has {u.fromName}
            {u.qtyText ? `, ${u.qtyText}` : ""}. A better underlay feels softer underfoot and helps your carpet last.
          </p>
          {u.settled ? (
            <p className="mt-2 flex items-center gap-1.5 rounded-md bg-[#3F7D3A]/10 px-2.5 py-1.5 text-sm text-[#2E6B4F]">
              <Check className="size-4 shrink-0" />
              Upgraded. It is added to your job as a variation and goes on your final invoice.
            </p>
          ) : fixed ? (
            <p className="mt-2 text-sm">{answer === "yes" ? "You said yes to the upgrade." : answer === "no" ? "You said no thanks." : "No answer was given."}</p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant={answer === "yes" ? "default" : "outline"} onClick={() => onAnswer("yes")} aria-pressed={answer === "yes"}>
                {answer === "yes" ? <Check className="size-4" /> : null}
                Yes, upgrade
              </Button>
              <Button variant={answer === "no" ? "default" : "outline"} onClick={() => onAnswer("no")} aria-pressed={answer === "no"}>
                {answer === "no" ? <Check className="size-4" /> : null}
                No thanks
              </Button>
            </div>
          )}
          {!fixed && answer === "yes" ? (
            <p className="mt-2 rounded-md bg-[var(--gold)]/10 px-2.5 py-1.5 text-xs">
              When you send this form the upgrade is added to your job as a variation. It goes on your final invoice. Your deposit does not change.
            </p>
          ) : null}
        </div>
      </div>
    </PublicCard>
  );
}

function Swatch({ option, size = "lg" }: { option: Pick<Option, "colour" | "swatchUrl">; size?: "lg" | "sm" }) {
  const box = size === "lg" ? "size-28 sm:size-32" : "aspect-square w-full";
  if (option.swatchUrl) {
    return <img src={option.swatchUrl} alt={option.colour} className={`${box} shrink-0 rounded-lg border border-border object-cover`} />;
  }
  return (
    <div className={`${box} flex shrink-0 items-center justify-center rounded-lg border border-border bg-secondary p-2 text-center`}>
      <span className="text-sm font-semibold leading-tight text-foreground/80">{option.colour || "No colour"}</span>
    </div>
  );
}

/** What a pick does, in the client's words. */
function changeText(o: Option | undefined, showPrices: boolean) {
  if (!o || o.change === "same") return null;
  if (o.change === "swap") return "Same price as your quote.";
  if (o.change === "dearer") {
    return o.extraIncGst != null
      ? `This colour adds ${moneyExact(o.extraIncGst)} inc GST. We will check it and send a variation to sign before we order.`
      : "This colour costs more than the one quoted. We will check it and be in touch before we order.";
  }
  return o.extraIncGst != null && showPrices
    ? `This colour is ${moneyExact(Math.abs(o.extraIncGst))} inc GST less. We will be in touch about the price.`
    : "This colour costs less than the one quoted. We will be in touch about the price.";
}

function ColourPicker({
  section,
  picked,
  showPrices,
  onPick,
  onClose,
}: {
  section: Section;
  picked: number;
  showPrices: boolean;
  onPick: (productId: number) => void;
  onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose} title={`Colours in ${section.title}`} subtitle="Only colours from the same range can be picked here." width="max-w-2xl">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {section.options.map((o) => {
          const on = o.productId === picked;
          const price =
            o.extraIncGst != null && showPrices
              ? o.change === "dearer"
                ? `+${moneyExact(o.extraIncGst)}`
                : `${moneyExact(Math.abs(o.extraIncGst))} less`
              : o.change === "dearer"
                ? "Costs more"
                : o.change === "cheaper"
                  ? "Costs less"
                  : o.productId === section.quotedProductId
                    ? "As quoted"
                    : "Same price";
          return (
            <button
              key={o.productId}
              type="button"
              onClick={() => onPick(o.productId)}
              className={`flex flex-col gap-1.5 rounded-xl border p-2 text-left transition-colors ${
                on ? "border-[var(--gold)] bg-[var(--gold)]/10 ring-2 ring-[var(--gold)]" : "border-border hover:bg-secondary"
              }`}
            >
              <Swatch option={o} size="sm" />
              <span className="flex items-center gap-1 text-sm font-semibold leading-tight">
                {on ? <Check className="size-3.5 shrink-0 text-[var(--gold)]" /> : null}
                {o.colour}
              </span>
              <span className="text-xs text-muted-foreground">{price}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

export function ProductSelection({ token, d }: { token: string; d: Data }) {
  const submit = useSubmitSelection();
  const [picks, setPicks] = React.useState<Record<number, number>>(() => Object.fromEntries(d.sections.map((s) => [s.itemId, s.productId])));
  const [notes, setNotes] = React.useState(d.notes ?? "");
  const [name, setName] = React.useState(d.submittedName ?? "");
  const [open, setOpen] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [answers, setAnswers] = React.useState<Record<number, "" | "yes" | "no">>(() =>
    Object.fromEntries(d.upgrades.map((u) => [u.itemId, u.answer])),
  );
  const [sent, setSent] = React.useState<null | { changed: number; upgraded: number }>(null);

  if (sent) {
    return (
      <PublicShell>
        <PublicMessage title="Thank you, we have your colours">
          {sent.changed
            ? "We will check your colour change against your quote and be in touch before we order."
            : "We will order what is on your quote."}{" "}
          {sent.upgraded ? "Your underlay upgrade is added to your job as a variation and goes on your final invoice." : ""}{" "}
          You can open this link again to make changes until we order.
        </PublicMessage>
        {!d.locked ? (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => setSent(null)}>
              Change my colours
            </Button>
          </div>
        ) : null}
      </PublicShell>
    );
  }

  const changed = d.sections.filter((s) => picks[s.itemId] !== s.quotedProductId).length;
  const openOffers = d.upgrades.filter((u) => !u.settled);

  async function onSubmit() {
    setError(null);
    if (name.trim().length < 2) return setError("Type your name so we know who confirmed.");
    if (openOffers.some((u) => !answers[u.itemId])) return setError("Tap Yes, upgrade or No thanks on the underlay upgrade.");
    try {
      await submit.mutateAsync({
        token,
        name: name.trim(),
        picks: d.sections.map((s) => ({ itemId: s.itemId, productId: picks[s.itemId] ?? s.productId })),
        notes,
        upgrades: openOffers.flatMap((u) => {
          const a = answers[u.itemId];
          return a ? [{ itemId: u.itemId, answer: a }] : [];
        }),
      });
      setSent({ changed, upgraded: openOffers.filter((u) => answers[u.itemId] === "yes").length + d.upgrades.filter((u) => u.settled).length });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError(errorText(e));
    }
  }

  const openSection = open != null ? d.sections.find((s) => s.itemId === open) : undefined;

  return (
    <PublicShell>
      <PublicCard>
        <p className="label-xs">Job {d.jobRef}</p>
        <h1 className="text-2xl font-bold tracking-[-0.015em]">Check your flooring colours</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {d.firstName ? `Hi ${d.firstName}. ` : ""}Here is what is on your quote{d.siteAddress ? ` for ${d.siteAddress}` : ""}. If it all looks right,
          type your name at the bottom and send. If you would like a different colour from the same range, you can change it here.
          {d.upgrades.some((u) => !u.settled) ? " There is an underlay upgrade offer below too." : ""}
        </p>
        {d.status === "submitted" && d.submittedAt ? (
          <p className="mt-3 rounded-md bg-[#3F7D3A]/10 px-3 py-2 text-sm text-[#2E6B4F]">
            {d.submittedName || "You"} sent this on {new Date(d.submittedAt).toLocaleDateString("en-AU", { day: "numeric", month: "long" })}.
            {d.locked ? "" : " You can still change it below."}
          </p>
        ) : null}
        {d.locked ? (
          <p className="mt-3 flex items-start gap-2 rounded-md bg-secondary px-3 py-2 text-sm">
            <Lock className="mt-0.5 size-4 shrink-0" />
            {d.lockReason}
          </p>
        ) : null}
      </PublicCard>

      {d.sections.map((s) => {
        const pickedId = picks[s.itemId] ?? s.productId;
        const option = s.options.find((o) => o.productId === pickedId);
        const shown = option ?? { colour: s.quotedColour, swatchUrl: null };
        const note = changeText(option, d.showPrices);
        return (
          <PublicCard key={s.itemId}>
            <div className="flex gap-4">
              <Swatch option={shown} />
              <div className="min-w-0 flex-1">
                <p className="label-xs">{s.kindLabel}</p>
                <h2 className="text-lg font-bold leading-tight tracking-[-0.01em]">{s.title}</h2>
                <p className="mt-1 text-sm">
                  Colour: <span className="font-semibold">{shown.colour || "No colour"}</span>
                </p>
                {pickedId !== s.quotedProductId ? (
                  <p className="text-xs text-muted-foreground">Your quote had {s.quotedColour}.</p>
                ) : null}
                {s.qtyText ? <p className="text-xs text-muted-foreground">{s.qtyText}</p> : null}
                {note ? <p className="mt-2 rounded-md bg-[var(--gold)]/10 px-2.5 py-1.5 text-xs">{note}</p> : null}
              </div>
            </div>
            {!d.locked && s.options.length > 1 ? (
              <button
                type="button"
                onClick={() => setOpen(s.itemId)}
                className="mt-3 flex items-center gap-1.5 text-sm font-medium text-[var(--gold-deep)] underline-offset-2 hover:underline"
              >
                <Palette className="size-4" />
                Thinking about a different colour? Change it here
              </button>
            ) : null}
            {!d.locked && s.options.length > 1 && pickedId !== s.quotedProductId ? (
              <button
                type="button"
                onClick={() => setPicks({ ...picks, [s.itemId]: s.quotedProductId })}
                className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                Go back to {s.quotedColour}
              </button>
            ) : null}
          </PublicCard>
        );
      })}

      {d.upgrades.map((u) => (
        <UpgradeCard
          key={u.itemId}
          u={u}
          answer={answers[u.itemId] ?? ""}
          locked={d.locked}
          onAnswer={(a) => {
            setAnswers({ ...answers, [u.itemId]: a });
            setError(null);
          }}
        />
      ))}

      {!d.locked ? (
        <PublicCard>
          <div className="flex flex-col gap-3">
            <Field label="Anything else we should know?">
              <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
            </Field>
            <Field label="Your name">
              <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </Field>
            {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
            <Button size="lg" onClick={onSubmit} disabled={submit.isPending} className="w-full sm:w-auto sm:self-end">
              {submit.isPending ? <Spinner /> : <Check className="size-4" />}
              {changed ? "Send my colour change" : d.sections.length ? "Confirm these colours" : "Send my answer"}
            </Button>
          </div>
        </PublicCard>
      ) : d.notes ? (
        <PublicCard title="Your note">
          <p className="whitespace-pre-wrap text-sm">{d.notes}</p>
        </PublicCard>
      ) : null}

      {openSection ? (
        <ColourPicker
          section={openSection}
          picked={picks[openSection.itemId] ?? openSection.productId}
          showPrices={d.showPrices}
          onPick={(id) => {
            setPicks({ ...picks, [openSection.itemId]: id });
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </PublicShell>
  );
}
