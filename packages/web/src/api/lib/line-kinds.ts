/**
 * Quote and variation line kinds that more than one file needs. No server
 * imports, so the web app can use them too.
 *
 * 188001 fix list item 6: delivery is its own kind. It is not a material and
 * not labour: it never goes on Materials to order or a supplier PO, and its
 * cost goes to Money out as an Other cost (lib/delivery-cost.ts).
 */

export const DELIVERY = "delivery";

/**
 * Notes 18.33. A supplier's freight or charge, worked out from its rules
 * (lib/quote-freight.ts). Internal: the client copy spreads its sell into that
 * supplier's product lines (lib/charge-fold.ts). It never goes on Materials to
 * order or a PO, which adds the supplier charges itself. Its cost counts with
 * that supplier's materials in Money out, so the PO replaces it.
 */
export const SUPPLIER_CHARGE = "supplier_charge";

/** Labour, prep and removal are labour. Delivery is delivery. Everything else is material. */
export function lineTypeOfKind(kind: string): "labour" | "material" | "delivery" {
  if (kind === "labour" || kind === "prep" || kind === "removal") return "labour";
  if (kind === DELIVERY) return "delivery";
  return "material";
}

/** A line typed in by hand that is a delivery charge: "Delivery to site", "Freight", "Cartage". */
export const isDeliveryText = (description: string) => /^\s*(?:delivery|freight|cartage)\b/i.test(description);

/** What the line kind picker shows. */
export const KIND_LABELS: Record<string, string> = {
  supply: "Supply",
  accessory: "Accessory",
  labour: "Labour",
  prep: "Prep",
  removal: "Removal",
  delivery: "Delivery",
  other: "Other",
  supplier_charge: "Supplier charge",
};
