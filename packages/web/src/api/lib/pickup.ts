import { and, asc, eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/* ---------------------------------------------------------------------------
 * PICK UP FROM SUPPLIER (Damien, 9 Nov 2026).
 *
 * A PO can be delivered to the warehouse, delivered to site, or collected
 * from the supplier. A pickup is collected by Terra (or its installer) from
 * one of the supplier's depots. It is never a customer collecting from Terra.
 *
 *   - The pickup place is kept on the PO itself (pickup_name, pickup_address).
 *     It never goes into delivery_address, the job's site, Terra's warehouse
 *     or the supplier's own address.
 *   - It may be left "to be confirmed": no address is ever guessed or filled
 *     from the site.
 *   - A depot is only saved for next time when the office says so, and the
 *     same address is never saved twice for one supplier.
 *   - Editing a saved depot's address on a PO changes that PO only, unless the
 *     office also asks to update the saved depot. A PO already written keeps
 *     its own copy either way.
 * ------------------------------------------------------------------------- */

export const PICKUP_HEADING = "PICKUP FROM SUPPLIER";
export const PICKUP_TBC = "PICKUP FROM SUPPLIER - DEPOT/ADDRESS TO BE CONFIRMED";

const WORDS: Record<string, string> = {
  st: "street",
  rd: "road",
  dr: "drive",
  ave: "avenue",
  av: "avenue",
  cres: "crescent",
  cr: "crescent",
  ct: "court",
  pl: "place",
  hwy: "highway",
  pde: "parade",
  cct: "circuit",
  bvd: "boulevard",
  blvd: "boulevard",
  ln: "lane",
  tce: "terrace",
  esp: "esplanade",
  qld: "",
  queensland: "",
  australia: "",
  unit: "",
  u: "",
};

/** The same place typed two ways comes out the same: "2/22 Lawrence Dr, Nerang QLD 4211" = "2 / 22 lawrence drive nerang 4211". */
export function addressKey(address: string): string {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .split(" ")
    .filter(Boolean)
    .map((w) => (w in WORDS ? WORDS[w] : w))
    .filter(Boolean)
    .join(" ");
}

export type PickupChoice = {
  /** depot: a saved depot. new: typed now. tbc: depot/address to be confirmed. */
  mode: "depot" | "new" | "tbc";
  depotId?: number | null;
  name?: string;
  address?: string;
  /** new: "Save for next time". */
  save?: boolean;
  /** depot, edited: also change the saved depot (otherwise this PO only). */
  updateSaved?: boolean;
};

export type PickupResolved = { pickupDepotId: number | null; pickupName: string; pickupAddress: string; saved: "created" | "reused" | "updated" | null };

const NONE: PickupResolved = { pickupDepotId: null, pickupName: "", pickupAddress: "", saved: null };

export class PickupError extends Error {}

export async function depotsFor(supplierId: number) {
  return db
    .select({ id: schema.supplierDepots.id, name: schema.supplierDepots.name, address: schema.supplierDepots.address })
    .from(schema.supplierDepots)
    .where(and(eq(schema.supplierDepots.supplierId, supplierId), eq(schema.supplierDepots.active, true)))
    .orderBy(asc(schema.supplierDepots.name), asc(schema.supplierDepots.id));
}

/** A saved depot of this supplier at the same address, if there is one. */
export async function matchingDepot(supplierId: number, address: string) {
  const key = addressKey(address);
  if (!key) return null;
  const [d] = await db
    .select()
    .from(schema.supplierDepots)
    .where(and(eq(schema.supplierDepots.supplierId, supplierId), eq(schema.supplierDepots.addressKey, key)));
  return d ?? null;
}

/**
 * Works out what goes on the PO for a pickup, and saves or updates a depot
 * only when asked. Not a pickup: all blank. Throws PickupError for anything
 * that cannot be right (a depot of another supplier, a new place with no
 * address).
 */
export async function resolvePickup(supplierId: number, deliverTo: string, choice: PickupChoice | null | undefined, byName: string): Promise<PickupResolved> {
  if (deliverTo !== "pickup") return NONE;
  const c = choice ?? { mode: "tbc" };
  const name = (c.name ?? "").trim().slice(0, 120);
  const address = (c.address ?? "").trim().slice(0, 300);
  if (c.mode === "tbc") return NONE;

  if (c.mode === "depot") {
    if (!c.depotId) throw new PickupError("Pick a saved pickup location, or choose another option.");
    const [d] = await db.select().from(schema.supplierDepots).where(eq(schema.supplierDepots.id, c.depotId));
    if (!d || !d.active) throw new PickupError("That saved pickup location is no longer there. Pick again.");
    if (d.supplierId !== supplierId) throw new PickupError("That pickup location belongs to another supplier. Pick a location for this supplier.");
    const outName = name || d.name;
    const outAddress = address || d.address;
    const edited = outName !== d.name || addressKey(outAddress) !== d.addressKey;
    if (edited && c.updateSaved) {
      const key = addressKey(outAddress);
      if (!key) throw new PickupError("Type the pickup address.");
      const clash = await matchingDepot(supplierId, outAddress);
      if (clash && clash.id !== d.id) throw new PickupError(`That address is already saved as "${clash.name || clash.address}". Pick that one instead.`);
      await db.update(schema.supplierDepots).set({ name: outName, address: outAddress, addressKey: key, updatedAt: new Date() }).where(eq(schema.supplierDepots.id, d.id));
      return { pickupDepotId: d.id, pickupName: outName, pickupAddress: outAddress, saved: "updated" };
    }
    return { pickupDepotId: d.id, pickupName: outName, pickupAddress: outAddress, saved: null };
  }

  // A new place.
  if (!address) {
    // A branch name with no address yet: on this PO only, still shown as address to be confirmed. Never saved.
    if (name && !c.save) return { pickupDepotId: null, pickupName: name, pickupAddress: "", saved: null };
    throw new PickupError(c.save ? "Type the pickup address before saving it for next time." : "Type the pickup address, or choose Pickup - location to be confirmed.");
  }
  const existing = await matchingDepot(supplierId, address);
  if (existing && existing.active) {
    // Never a second copy of a saved depot. Use the saved one; the name typed stays on this PO.
    return { pickupDepotId: existing.id, pickupName: name || existing.name, pickupAddress: address, saved: c.save ? "reused" : null };
  }
  if (!c.save) return { pickupDepotId: null, pickupName: name, pickupAddress: address, saved: null };
  if (existing && !existing.active) {
    await db.update(schema.supplierDepots).set({ active: true, name: name || existing.name, address, updatedAt: new Date() }).where(eq(schema.supplierDepots.id, existing.id));
    return { pickupDepotId: existing.id, pickupName: name || existing.name, pickupAddress: address, saved: "reused" };
  }
  const [row] = await db
    .insert(schema.supplierDepots)
    .values({ supplierId, name, address, addressKey: addressKey(address), createdByName: byName.slice(0, 120) })
    .returning({ id: schema.supplierDepots.id });
  return { pickupDepotId: row!.id, pickupName: name, pickupAddress: address, saved: "created" };
}

/** What the PO PDF and email say for a pickup. */
export function pickupLines(po: { pickupName: string; pickupAddress: string }): string[] {
  const name = po.pickupName.trim();
  const address = po.pickupAddress.trim();
  if (!address && !name) return [PICKUP_TBC];
  if (!address) return [PICKUP_HEADING, name, "Address to be confirmed"];
  return [PICKUP_HEADING, ...(name ? [name] : []), address];
}
