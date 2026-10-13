/**
 * 188001 list item 12: a quote with a delivery line and no site. The address
 * is often only in the line's text ("Delivery to Shop 1115, Westfield
 * Carindale"). This makes a first guess at the site form from it, so the
 * office only has to check it and save. No server imports, so the web app
 * can use it too.
 */

export interface SiteGuess {
  address: string;
  suburb: string;
  state: string;
  postcode: string;
}

const STATES = ["QLD", "NSW", "VIC", "SA", "WA", "TAS", "NT", "ACT"];

export function siteGuessFromText(text: string): SiteGuess {
  let t = (text ?? "").replace(/\s+/g, " ").trim();
  // "Delivery to", "Freight -", "Cartage:" and the like.
  t = t.replace(/^(?:delivery|freight|cartage)\b\s*(?:charge\b\s*)?(?:to\b|-|:)?\s*/i, "");
  t = t.replace(/[\s.,;]+$/, "");

  let state = "QLD";
  let postcode = "";
  let before = t;
  const m = new RegExp(`[\\s,]+(${STATES.join("|")})\\b\\.?(?:\\s*(\\d{4}))?\\s*$`, "i").exec(t);
  if (m) {
    state = m[1]!.toUpperCase();
    postcode = m[2] ?? "";
    before = t.slice(0, m.index);
  } else {
    const pc = /[\s,]+(\d{4})\s*$/.exec(t);
    if (pc && /,/.test(t.slice(0, pc.index))) {
      postcode = pc[1]!;
      before = t.slice(0, pc.index);
    }
  }
  before = before.replace(/[\s,]+$/, "");

  // With a state or postcode found, the part after the last comma is the
  // suburb when it is a few words with no numbers.
  let suburb = "";
  let address = before;
  if (m || postcode) {
    const at = before.lastIndexOf(",");
    const tail = at >= 0 ? before.slice(at + 1).trim() : "";
    if (tail && !/\d/.test(tail) && tail.split(" ").length <= 3) {
      suburb = tail;
      address = before.slice(0, at).trim();
    }
  }
  return { address, suburb, state, postcode };
}
