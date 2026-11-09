import * as React from "react";
import { MapPin, TriangleAlert } from "lucide-react";
import { AddressAutocomplete, billingLine } from "./address-autocomplete";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/field";
import { Spinner } from "./ui/card";
import { useDepotMatch, useSupplierDepots } from "../queries/purchasing";

/**
 * PICK UP FROM SUPPLIER on a PO (Damien, 9 Nov 2026).
 *
 * A saved depot of the supplier, a place typed now, or "to be confirmed".
 * Never the site, the warehouse or the supplier's billing address. A depot is
 * only remembered after "Save for next time", a saved one is reused rather
 * than saved twice, and editing a saved one asks whether it is this PO only.
 */

export type PickupDraft = {
  /** null: nothing picked yet (a new pickup, or the supplier just changed). */
  mode: "depot" | "new" | "tbc" | null;
  depotId: number | null;
  name: string;
  address: string;
  /** New place: null until "Save for next time" or "Use for this PO only" is pressed. */
  save: boolean | null;
  /** Saved depot edited on this PO: null until "This PO only" or "Also update the saved location". */
  updateSaved: boolean | null;
  /** Saved depot: the name and address boxes are open for a change on this PO. */
  editing: boolean;
};

export const NO_PICKUP: PickupDraft = { mode: null, depotId: null, name: "", address: "", save: null, updateSaved: null, editing: false };

type Depot = { id: number; name: string; address: string };

/** What a saved draft reopens with. It keeps the PO's own copy, even if the saved depot has changed since. */
export function pickupFromPo(po: { deliverTo: string; pickupDepotId?: number | null; pickupName?: string; pickupAddress?: string } | null): PickupDraft {
  if (!po || po.deliverTo !== "pickup") return NO_PICKUP;
  const name = po.pickupName ?? "";
  const address = po.pickupAddress ?? "";
  if (po.pickupDepotId) return { ...NO_PICKUP, mode: "depot", depotId: po.pickupDepotId, name, address };
  if (name || address) return { ...NO_PICKUP, mode: "new", name, address, save: false };
  return { ...NO_PICKUP, mode: "tbc" };
}

const same = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

function depotEdited(d: PickupDraft, depot: Depot | undefined) {
  if (d.mode !== "depot" || !depot) return false;
  return !same(d.name || depot.name, depot.name) || !same(d.address || depot.address, depot.address);
}

/** Why the PO can't be saved yet, in plain words. null: fine. */
export function pickupProblem(d: PickupDraft, depots: Depot[] | undefined): string | null {
  if (d.mode === null) return "Choose where to pick up from: a saved location, a new location, or location to be confirmed.";
  if (d.mode === "depot") {
    const depot = depots?.find((x) => x.id === d.depotId);
    if (!depot) return "That saved pickup location is not on file for this supplier. Pick again.";
    if (!d.address.trim()) return "Type the pickup address, or choose Pickup - location to be confirmed.";
    if (depotEdited(d, depot) && d.updateSaved === null) return "You changed a saved pickup location. Choose This PO only or Also update the saved location.";
  }
  if (d.mode === "new") {
    if (!d.address.trim() && !d.name.trim()) return "Type the pickup address, or choose Pickup - location to be confirmed.";
    if (d.address.trim() && d.save === null) return "Choose Save for next time or Use for this PO only.";
  }
  return null;
}

/** What goes to the server. */
export function pickupInputOf(d: PickupDraft) {
  if (d.mode === null) return null;
  if (d.mode === "tbc") return { mode: "tbc" as const };
  return {
    mode: d.mode,
    depotId: d.mode === "depot" ? d.depotId : null,
    name: d.name.trim(),
    address: d.address.trim(),
    save: d.mode === "new" ? d.save === true : false,
    updateSaved: d.mode === "depot" ? d.updateSaved === true : false,
  };
}

/** A map link only once there is a real address. Never the site's. */
export function mapsLink(address: string) {
  return address.trim() ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.trim())}` : null;
}

function Choice({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={
        on
          ? "flex w-full items-start gap-2.5 rounded-md border border-primary bg-primary/[0.06] px-3 py-2 text-left"
          : "flex w-full items-start gap-2.5 rounded-md border border-border px-3 py-2 text-left hover:border-foreground/30"
      }
    >
      <span className={on ? "mt-1 size-3 shrink-0 rounded-full border-[3.5px] border-primary" : "mt-1 size-3 shrink-0 rounded-full border border-muted-foreground/60"} />
      <span className="min-w-0 flex-1 text-sm">{children}</span>
    </button>
  );
}

function Ask({ question, yes, no, value, onPick }: { question: string; yes: string; no: string; value: boolean | null; onPick: (v: boolean) => void }) {
  return (
    <div className="rounded-md border border-border bg-secondary/50 px-3 py-2.5" data-testid="pickup-ask">
      <p className="text-sm font-medium">{question}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant={value === true ? "default" : "outline"} onClick={() => onPick(true)}>
          {yes}
        </Button>
        <Button size="sm" variant={value === false ? "default" : "outline"} onClick={() => onPick(false)}>
          {no}
        </Button>
      </div>
    </div>
  );
}

export function PickupPanel({ supplierId, supplierName, value, onChange }: { supplierId: number | null; supplierName: string; value: PickupDraft; onChange: (d: PickupDraft) => void }) {
  const depots = useSupplierDepots(supplierId);
  const list = depots.data ?? [];
  const d = value;
  const set = (patch: Partial<PickupDraft>) => onChange({ ...d, ...patch });
  const [typed, setTyped] = React.useState(d.address);
  React.useEffect(() => {
    const t = setTimeout(() => setTyped(d.address), 400);
    return () => clearTimeout(t);
  }, [d.address]);
  const match = useDepotMatch(d.mode === "new" ? supplierId : null, typed);
  const existing = d.mode === "new" && d.address.trim() ? match.data : null;
  const depot = list.find((x) => x.id === d.depotId);
  const edited = depotEdited(d, depot);
  const map = mapsLink(d.mode === "tbc" ? "" : d.address);

  return (
    <div className="space-y-2" data-testid="pickup-panel">
      <p className="text-xs text-muted-foreground">
        Terra collects from {supplierName || "the supplier"}. Not the site or the warehouse.
      </p>
      {depots.isLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> Loading saved pickup locations…
        </p>
      ) : null}
      {list.map((x) => (
        <Choice
          key={x.id}
          testId={`pickup-depot-${x.id}`}
          on={d.mode === "depot" && d.depotId === x.id}
          onClick={() => onChange({ ...NO_PICKUP, mode: "depot", depotId: x.id, name: x.name, address: x.address })}
        >
          <span className="block font-medium">{x.name || "Saved pickup location"}</span>
          <span className="block text-xs text-muted-foreground">{x.address}</span>
        </Choice>
      ))}
      {d.mode === "depot" && d.depotId != null && !depot && !depots.isLoading ? (
        <p className="text-xs text-destructive">The saved location on this PO is no longer on file for {supplierName}. Pick again.</p>
      ) : null}
      <Choice testId="pickup-new" on={d.mode === "new"} onClick={() => d.mode !== "new" && onChange({ ...NO_PICKUP, mode: "new" })}>
        <span className="block font-medium">New pickup location</span>
        <span className="block text-xs text-muted-foreground">Type the depot or branch and its address.</span>
      </Choice>
      <Choice testId="pickup-tbc" on={d.mode === "tbc"} onClick={() => onChange({ ...NO_PICKUP, mode: "tbc" })}>
        <span className="block font-medium">Pickup - location to be confirmed</span>
        <span className="block text-xs text-muted-foreground">Save and send it now. The PO says the depot and address are to be confirmed.</span>
      </Choice>

      {d.mode === "tbc" ? (
        <p className="flex items-start gap-2 rounded-md border border-[var(--warning)]/35 bg-[var(--warning)]/[0.06] px-3 py-2 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
          Depot and address not confirmed yet. The PO will say PICKUP FROM SUPPLIER - DEPOT/ADDRESS TO BE CONFIRMED.
        </p>
      ) : null}

      {d.mode === "new" || (d.mode === "depot" && d.editing) ? (
        <div className="space-y-2 rounded-md border border-border px-3 py-2.5">
          <Field label="Depot or branch name">
            <Input value={d.name} onChange={(e) => set({ name: e.target.value, updateSaved: null })} placeholder="e.g. Nerang branch" />
          </Field>
          <Field label="Pickup address" hint="Pick from the list or type it in.">
            <AddressAutocomplete
              id="po_pickup_address"
              value={d.address}
              onType={(v) => set({ address: v, updateSaved: null, ...(d.mode === "new" ? { save: null } : {}) })}
              onPick={(a) => set({ address: billingLine(a), updateSaved: null, ...(d.mode === "new" ? { save: null } : {}) })}
              placeholder="Street, suburb"
              icon
            />
          </Field>
        </div>
      ) : null}

      {d.mode === "depot" && depot && !d.editing ? (
        <Button size="sm" variant="ghost" onClick={() => set({ editing: true })}>
          Change name or address
        </Button>
      ) : null}

      {d.mode === "depot" && edited ? (
        <Ask
          question={`Is this change for this PO only, or should the saved ${supplierName} location change too?`}
          yes="Also update the saved location"
          no="This PO only"
          value={d.updateSaved}
          onPick={(v) => set({ updateSaved: v })}
        />
      ) : null}

      {existing ? (
        <div className="rounded-md border border-border bg-secondary/50 px-3 py-2.5" data-testid="pickup-match">
          <p className="text-sm">
            Already saved for {supplierName}: <span className="font-medium">{existing.name || "pickup location"}</span>, {existing.address}.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => onChange({ ...NO_PICKUP, mode: "depot", depotId: existing.id, name: existing.name, address: existing.address })}>
              Use the saved location
            </Button>
            <Button size="sm" variant={d.save === false ? "default" : "outline"} onClick={() => set({ save: false })}>
              Use for this PO only
            </Button>
          </div>
        </div>
      ) : d.mode === "new" && d.address.trim() ? (
        <Ask
          question={`Save this pickup location for future orders with ${supplierName || "this supplier"}?`}
          yes="Save for next time"
          no="Use for this PO only"
          value={d.save}
          onPick={(v) => set({ save: v })}
        />
      ) : d.mode === "new" && d.name.trim() ? (
        <p className="text-xs text-muted-foreground">No address yet. The PO shows the name with the address to be confirmed, and it is not saved for next time.</p>
      ) : null}

      {map ? (
        <a href={map} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          <MapPin className="size-3.5" /> Open in Maps
        </a>
      ) : null}
    </div>
  );
}
