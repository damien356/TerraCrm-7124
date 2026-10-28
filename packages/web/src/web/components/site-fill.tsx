import * as React from "react";
import { MapPin } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox, Field, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { NewSiteFields, blankSite, sitePayload, type NewSiteDraft } from "./new-records";
import { useChangeJobSite, useJobSiteChangeInfo, useJobSiteNeed, useSaveSiteFill } from "../queries/siteFill";

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

/** The job page's Site block: the address with Change, or "No site. Add one" with the same form. */
export function JobSiteFact({
  jobId,
  site,
}: {
  jobId: number;
  site: { address: string; suburb: string | null; geoSource?: string | null } | null;
}) {
  const need = useJobSiteNeed(jobId);
  const [open, setOpen] = React.useState(false);
  const [changing, setChanging] = React.useState(false);
  if (site) {
    // Typed by hand, or the backfill could not find it: Navigate goes by the text, so it may land wrong.
    const unchecked = site.geoSource !== "google" && site.geoSource !== "lookup";
    return (
      <>
        <p className="mt-0.5 text-sm">{site.address}</p>
        <p className="text-xs text-muted-foreground">{site.suburb ?? ""}</p>
        {unchecked ? <p className="mt-0.5 text-xs text-amber-700">Not checked with Google</p> : null}
        <button type="button" className="mt-0.5 text-xs font-medium text-primary hover:underline" onClick={() => setChanging(true)}>
          Change address
        </button>
        <SiteChangeModal open={changing} onClose={() => setChanging(false)} jobId={jobId} />
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Change the address on a job that already has one. Two different things:
 * the same place typed wrong (correct the site, every job there follows), or
 * this job is somewhere else (it moves to another site, other jobs keep theirs).
 */
export function SiteChangeModal({ open, onClose, jobId }: { open: boolean; onClose: () => void; jobId: number }) {
  const info = useJobSiteChangeInfo(jobId, open);
  const change = useChangeJobSite();
  const [draft, setDraft] = React.useState<NewSiteDraft>(blankSite);
  const [scope, setScope] = React.useState<"fix" | "move">("fix");
  const [existing, setExisting] = React.useState<{ id: number; label: string } | null>(null);
  const [tellCrew, setTellCrew] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const d = info.data;
  // Each time it opens it starts from the address on file. Once only, so the refetch after saving keeps the result on screen.
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (!d || seeded.current) return;
    seeded.current = true;
    setDraft({
      address: d.site.address,
      suburb: d.site.suburb ?? "",
      state: d.site.state || "QLD",
      postcode: d.site.postcode ?? "",
      propertyType: d.site.propertyType ?? "",
      lat: d.site.lat,
      lng: d.site.lng,
      placeId: d.site.placeId,
    });
    setScope("fix");
    setExisting(null);
    setTellCrew(true);
    setError(null);
    setDone(null);
  }, [open, d]);

  const others = d?.otherJobs ?? [];
  const shared = others.length > 0;
  // Picking another site that is already in Ops is always a move.
  const effective = existing ? "move" : shared ? scope : "fix";
  const crew = (d?.crew ?? []).filter((c) => effective === "fix" || c.thisJob);
  const crewNames = [...new Set(crew.map((c) => c.name))];
  const sentPos = (d?.sentPos ?? []).filter((p) => effective === "fix" || p.thisJob);
  const draftPos = (d?.draftPos ?? []).filter((p) => effective === "fix" || p.thisJob);
  const swms = effective === "fix" ? (d?.swmsAll ?? 0) : (d?.swmsThisJob ?? 0);

  async function onSave() {
    setError(null);
    try {
      const out = await change.mutateAsync({
        jobId,
        scope: effective,
        ...(existing ? { siteId: existing.id } : { newSite: sitePayload(draft) }),
        tellCrew: tellCrew && crew.length > 0,
      });
      const bits = [
        out.jobsChanged > 1 ? `Changed on ${plural(out.jobsChanged, "job")}.` : "Saved.",
        out.crewTold ? `${plural(out.crewTold, "crew member")} told in the app.` : "",
        out.draftPosUpdated.length ? `${plural(out.draftPosUpdated.length, "draft PO")} updated.` : "",
        out.sentPosKeptOld.length ? `Tell the supplier about ${out.sentPosKeptOld.join(", ")}: sent POs keep the old address.` : "",
      ];
      setDone(bits.filter(Boolean).join(" "));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const current = d ? [d.site.address, d.site.suburb].filter(Boolean).join(", ") : "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change the site address"
      subtitle={current ? `On file now: ${current}` : undefined}
      width="max-w-xl"
      footer={
        done ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={!d || change.isPending || (!existing && !draft.address.trim())}>
              <MapPin className="size-4" />
              {change.isPending ? "Saving..." : "Save address"}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p className="text-sm">{done}</p>
      ) : !d ? (
        <p className="text-sm text-muted-foreground">{info.isError ? (info.error as Error).message : "Loading..."}</p>
      ) : (
        <div className="grid gap-3">
          {shared && !existing ? (
            <div className="grid gap-2 rounded-lg border border-border p-3 text-sm">
              <p className="font-medium">
                This address is also on {plural(others.length, "other job")}: {others.slice(0, 4).map((o) => o.ref).join(", ")}
                {others.length > 4 ? ` and ${others.length - 4} more` : ""}.
              </p>
              <label className="flex cursor-pointer items-start gap-2">
                <input type="radio" className="mt-1" name="site_scope" checked={scope === "fix"} onChange={() => setScope("fix")} />
                <span>
                  <span className="font-medium">Correct this address.</span> Same place, typed wrong. {others.length === 1 ? "Both jobs change." : `All ${others.length + 1} jobs change.`}
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2">
                <input type="radio" className="mt-1" name="site_scope" checked={scope === "move"} onChange={() => setScope("move")} />
                <span>
                  <span className="font-medium">This job is at a different address.</span> Only this job changes. The others keep the old one.
                </span>
              </label>
            </div>
          ) : null}

          {existing ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <span>
                Move this job to <span className="font-medium">{existing.label}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setExisting(null)}>
                Type the address instead
              </Button>
            </div>
          ) : (
            <NewSiteFields value={draft} onChange={setDraft} hideSiteId={d.site.id} onUseExisting={setExisting} />
          )}

          {crew.length ? (
            <label className="flex cursor-pointer items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <Checkbox className="mt-0.5" checked={tellCrew} onChange={(e) => setTellCrew(e.target.checked)} />
              <span>
                Booked crew: {crewNames.join(", ")}. Their app shows the new address straight away. Tick to send them a notification too.
              </span>
            </label>
          ) : null}

          {sentPos.length || draftPos.length || swms ? (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              {draftPos.length ? <li>
                  {plural(draftPos.length, "draft PO")} to site {draftPos.length === 1 ? "takes" : "take"} the new address.
                </li> : null}
              {sentPos.length ? (
                <li className="text-amber-800">
                  {plural(sentPos.length, "sent PO")} ({sentPos.map((p) => p.number).join(", ")}) {sentPos.length === 1 ? "keeps" : "keep"} the old delivery address. Tell the supplier.
                </li>
              ) : null}
              {swms ? <li>{plural(swms, "SWMS", "SWMS")} already made keep the address they were made with.</li> : null}
            </ul>
          ) : null}
          <p className="text-xs text-muted-foreground">Accepted quotes and invoices already sent keep the address they went out with.</p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
