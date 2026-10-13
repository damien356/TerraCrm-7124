import * as React from "react";
import { MapPin } from "lucide-react";
import { Button } from "./ui/button";
import { Field, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { NewSiteFields, blankSite, sitePayload, type NewSiteDraft } from "./new-records";
import { useJobSiteNeed, useSaveSiteFill } from "../queries/siteFill";

/* ---------------------------------------------------------------------------
 * 188001 list item 12: site is blank. One form for the quote builder (asked
 * before Send and Accept when there is a delivery line) and the job page
 * ("No site. Add one"). It starts filled in from the delivery line's text.
 * ------------------------------------------------------------------------- */

type Guess = { address: string; suburb: string; state: string; postcode: string } | null;

export function SiteFillModal({
  open,
  onClose,
  quoteId,
  jobId,
  deliveryText,
  guess,
  title = "Add the site",
  subtitle,
  saveLabel = "Save site",
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  quoteId?: number;
  jobId?: number;
  deliveryText: string | null;
  guess: Guess;
  title?: string;
  subtitle?: string;
  saveLabel?: string;
  onSaved?: (site: { siteId: number; address: string }) => void;
}) {
  const save = useSaveSiteFill();
  const [draft, setDraft] = React.useState<NewSiteDraft>(blankSite);
  const [access, setAccess] = React.useState("");
  const [existing, setExisting] = React.useState<{ id: number; label: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Each time it opens it starts again from the delivery line.
  React.useEffect(() => {
    if (!open) return;
    setDraft(guess ? { ...blankSite(), ...guess, state: guess.state || "QLD" } : blankSite());
    setAccess("");
    setExisting(null);
    setError(null);
  }, [open, guess]);

  async function onSave() {
    setError(null);
    try {
      const out = await save.mutateAsync({
        quoteId,
        jobId,
        ...(existing ? { siteId: existing.id } : { newSite: { ...sitePayload(draft), accessNotes: access.trim() || null } }),
      });
      onClose();
      onSaved?.(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle ?? "Filled in from the delivery line. Check it and save."}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={save.isPending || (!existing && !draft.address.trim())}>
            <MapPin className="size-4" />
            {saveLabel}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {deliveryText ? (
          <p className="rounded-md bg-secondary px-3 py-2 text-xs">
            <span className="label-xs">Delivery line</span>
            <br />
            {deliveryText}
          </p>
        ) : null}
        {existing ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
            <span>
              Using <span className="font-medium">{existing.label}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => setExisting(null)}>
              Type a new address
            </Button>
          </div>
        ) : (
          <>
            <NewSiteFields value={draft} onChange={setDraft} onUseExisting={setExisting} />
            <Field label="Access notes" hint="Dock, gate code, parking. Kept on the site for every job there.">
              <Textarea id="sitefill_access" rows={2} value={access} onChange={(e) => setAccess(e.target.value)} />
            </Field>
          </>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

/** The job page's Site block: the address, or "No site. Add one" with the same form. */
export function JobSiteFact({
  jobId,
  site,
}: {
  jobId: number;
  site: { address: string; suburb: string | null; geoSource?: string | null } | null;
}) {
  const need = useJobSiteNeed(jobId);
  const [open, setOpen] = React.useState(false);
  if (site) {
    // Typed by hand, or the backfill could not find it: Navigate goes by the text, so it may land wrong.
    const unchecked = site.geoSource !== "google" && site.geoSource !== "lookup";
    return (
      <>
        <p className="mt-0.5 text-sm">{site.address}</p>
        <p className="text-xs text-muted-foreground">{site.suburb ?? ""}</p>
        {unchecked ? <p className="mt-0.5 text-xs text-amber-700">Not checked with Google</p> : null}
      </>
    );
  }
  return (
    <>
      <p className="mt-0.5 text-sm text-amber-700">
        No site.{" "}
        <button type="button" className="font-medium text-primary hover:underline" onClick={() => setOpen(true)}>
          Add one
        </button>
      </p>
      <SiteFillModal
        open={open}
        onClose={() => setOpen(false)}
        jobId={jobId}
        deliveryText={need.data?.deliveryText ?? null}
        guess={need.data?.guess ?? null}
        subtitle={need.data?.deliveryText ? undefined : "The job's address. Its open quotes take it too."}
      />
    </>
  );
}
