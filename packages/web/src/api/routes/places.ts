import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { staffOnly } from "../middleware/auth";

/**
 * ADDRESS AUTOCOMPLETE (Google Places API, New).
 *
 * Office types a site address on the New job screen and picks a suggestion;
 * the street, suburb, state and postcode fill themselves in. The Google key
 * stays on the server: the browser only ever talks to these two procedures.
 *
 * Billing: one typing session (many suggestion requests, then one pick) is
 * grouped by the screen's session token, and Google bills the session only
 * when the pick is looked up. With no key set, `enabled` is false and the
 * screen falls back to typing the address by hand.
 */

const key = () => process.env.GOOGLE_PLACES_API_KEY?.trim() || "";

/** Bias suggestions toward South East Queensland without ruling anything out. */
const BRISBANE = { latitude: -27.4698, longitude: 153.0251 };

export interface AddressParts {
  address: string;
  suburb: string;
  state: string;
  postcode: string;
  formatted: string;
}

interface Component {
  longText?: string;
  shortText?: string;
  types?: string[];
}

/** "2/14 Smith St", Paddington, QLD, 4064 from Google's address parts. */
export function addressFromComponents(components: Component[], formatted = ""): AddressParts {
  const get = (type: string, short = false) => {
    const c = components.find((x) => x.types?.includes(type));
    return (short ? c?.shortText : c?.longText) ?? c?.longText ?? "";
  };
  const unit = get("subpremise");
  const num = get("street_number");
  const street = get("route", true);
  const line = [unit && num ? `${unit}/${num}` : num || unit, street].filter(Boolean).join(" ");
  return {
    address: line || formatted.split(",")[0]?.trim() || "",
    suburb: get("locality") || get("sublocality") || get("postal_town"),
    state: get("administrative_area_level_1", true),
    postcode: get("postal_code"),
    formatted,
  };
}

async function google(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("places error", res.status, body.slice(0, 300));
    throw new ORPCError("BAD_GATEWAY", { message: "Address lookup is not answering. Type the address in by hand." });
  }
  return res.json() as Promise<any>;
}

export const places = {
  /** Whether autocomplete is switched on (a key is set). The key itself never leaves the server. */
  enabled: staffOnly.handler(() => ({ enabled: !!key() })),

  autocomplete: staffOnly
    .input(z.object({ input: z.string().trim().min(3).max(200), sessionToken: z.string().min(8).max(64) }))
    .handler(async ({ input }) => {
      if (!key()) return [];
      const data = await google("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key() },
        body: JSON.stringify({
          input: input.input,
          sessionToken: input.sessionToken,
          includedRegionCodes: ["au"],
          locationBias: { circle: { center: BRISBANE, radius: 50000 } },
          languageCode: "en-AU",
        }),
      });
      const out: Array<{ placeId: string; main: string; secondary: string }> = [];
      for (const s of data?.suggestions ?? []) {
        const p = s?.placePrediction;
        if (!p?.placeId) continue;
        out.push({
          placeId: String(p.placeId),
          main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
          secondary: p.structuredFormat?.secondaryText?.text ?? "",
        });
      }
      return out.slice(0, 6);
    }),

  /** The picked suggestion, split into the site's fields. Ends the billing session. */
  details: staffOnly
    .input(z.object({ placeId: z.string().min(1).max(300), sessionToken: z.string().min(8).max(64) }))
    .handler(async ({ input }) => {
      if (!key()) throw new ORPCError("BAD_REQUEST", { message: "Address lookup is not set up. Type the address in by hand." });
      const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(input.placeId)}?sessionToken=${encodeURIComponent(input.sessionToken)}&languageCode=en-AU`;
      const data = await google(url, {
        method: "GET",
        headers: { "X-Goog-Api-Key": key(), "X-Goog-FieldMask": "addressComponents,formattedAddress" },
      });
      return addressFromComponents(data?.addressComponents ?? [], data?.formattedAddress ?? "");
    }),
};
