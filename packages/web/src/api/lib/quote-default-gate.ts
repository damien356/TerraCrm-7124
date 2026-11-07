/**
 * Quote defaults gate (Damien's review, 7 Nov 2026). A warning the quote
 * defaults put on a line (enter the length, disposal rate not set, not
 * classified, not commercial, pick the trim area, and the rest, see
 * isDefaultWarning) stops the quote going to the customer until it is:
 *
 *  - filled in (the warning clears itself),
 *  - marked reviewed on the line (who and when are kept), or
 *  - the line is removed.
 *
 * Enforced on the server, on every path out: Send, staff Accept, Convert to
 * job, the send dialog, the phone agent, timber repair quotes (all through
 * assertReadyToGoOut) and a customer accepting online (lib/quote-accept.ts).
 *
 * A quote made before this feature has none of these warnings on it, so it
 * is not affected.
 */
import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { isDefaultWarning } from "./quote-default-rules";

type Line = typeof schema.quoteItems.$inferSelect;

/** True while a line still has a quote defaults warning nobody has dealt with. */
export function openDefaultWarning(l: Pick<Line, "flagged" | "flagReason" | "defaultReviewedAt">) {
  return Boolean(l.flagged && isDefaultWarning(l.flagReason) && !l.defaultReviewedAt);
}

/** What the customer sees if a quote with an open warning is accepted online. Nothing about prices or lines. */
export const DEFAULTS_OPEN_CUSTOMER =
  "We could not accept this quote online just now because our office is still finishing a detail on it. Nothing has been accepted or charged. Please reply to our email and we will sort it out.";

/** The open warnings on a quote, for the builder and the gate. */
export async function openDefaultWarnings(quoteId: number) {
  const lines = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quoteId));
  return lines.filter(openDefaultWarning).map((l) => ({ id: l.id, description: l.description, reason: l.flagReason ?? "" }));
}

/** Throws when the quote still has an open quote defaults warning. */
export async function assertDefaultsResolved(quoteId: number, via: "staff" | "online" = "staff") {
  const open = await openDefaultWarnings(quoteId);
  if (!open.length) return;
  if (via === "online") throw new ORPCError("BAD_REQUEST", { message: DEFAULTS_OPEN_CUSTOMER });
  const names = open.slice(0, 3).map((o) => `"${o.description}"`).join(", ");
  const more = open.length > 3 ? ` and ${open.length - 3} more` : "";
  throw new ORPCError("BAD_REQUEST", {
    message: `${open.length} line${open.length === 1 ? "" : "s"} put on by quote defaults still need${open.length === 1 ? "s" : ""} attention: ${names}${more}. Fill each one in, press Mark reviewed on it, or remove it.`,
    data: { defaultWarnings: open.map((o) => o.id) },
  });
}
