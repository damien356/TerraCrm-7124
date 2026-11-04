import { ORPCError } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { forbid, type PermActor, r4, unitText } from "./core";

/* ---------------------------------------------------------------------------
 * A2 follow-up (Damien, 4 Nov): the stock and PO overlap check also runs when
 * a PO is sent or marked sent, not only as an alert.
 *
 *  - Job PO: a line that orders more than the job still needs, because stock
 *    now covers part of it (the Step A overlap check, read only).
 *  - Warehouse PO: a job's share on the draft whose shortage is no longer
 *    open (stock found, or the job let it go).
 *
 * Found: Send and Mark sent stop. The office corrects the PO, or the main
 * admin sends it anyway with a reason. The override is written to the
 * activity log with who, when and the reason. Nothing on the PO is changed.
 * ------------------------------------------------------------------------- */

export type SendOverride = { reason: string } | null | undefined;

export async function poSendOverlaps(poId: number): Promise<string[]> {
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
  if (!po || po.status === "cancelled") return [];
  if (po.jobId != null) {
    const { poOverlapLines } = await import("./costs");
    return (await poOverlapLines(po.jobId, po.id)).map((o) => o.text);
  }
  const links = await db
    .select()
    .from(schema.stockPoLinks)
    .where(and(eq(schema.stockPoLinks.poId, po.id), eq(schema.stockPoLinks.status, "open")));
  if (!links.length) return [];
  const holdIds = links.map((k) => k.reservationId).filter((x): x is number => x != null);
  const holds = holdIds.length ? await db.select().from(schema.stockReservations).where(inArray(schema.stockReservations.id, holdIds)) : [];
  const jobIds = [...new Set(links.map((k) => k.jobId))];
  const jobs = await db.select({ id: schema.jobs.id, number: schema.jobs.number }).from(schema.jobs).where(inArray(schema.jobs.id, jobIds));
  const lines = await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, po.id));
  const prodIds = [...new Set(links.map((k) => k.productId))];
  const prods = await db.select().from(schema.products).where(inArray(schema.products.id, prodIds));
  const { stockUnitText } = await import("./replenish");
  const out: string[] = [];
  for (const k of links) {
    const h = holds.find((x) => x.id === k.reservationId);
    if (h && h.status === "short") continue;
    const job = jobs.find((j) => j.id === k.jobId)?.number ?? k.jobId;
    const line = lines.find((l) => l.id === k.poLineId);
    const p = prods.find((x) => x.id === k.productId);
    const u = p ? stockUnitText(p) : unitText(line?.unit);
    const why = !h ? "its shortage record is gone" : h.status === "released" || h.status === "cancelled" ? "the job no longer needs it" : "the job now has it from stock";
    out.push(
      `${po.number} still orders ${r4(k.qty)} ${u} for job ${job}, but ${why}. ${po.status === "draft" ? "Take the job share off the draft before sending it." : "The PO was not changed. Decide with the supplier."}`,
    );
  }
  return out;
}

/**
 * Called by Send and Mark sent. Throws while an overlap is open, unless the
 * main admin gives a reason. Returns what was overridden (empty: nothing).
 * Nothing is written here: the override goes in the activity log only once
 * the PO really counts as sent (logPoOverride).
 */
export async function assertPoSendable(poId: number, how: "send" | "mark_sent", override: SendOverride, actor: PermActor) {
  const found = await poSendOverlaps(poId);
  if (!found.length) return [];
  const reason = override?.reason?.trim() ?? "";
  if (!override) {
    throw new ORPCError("BAD_REQUEST", {
      message: `${found.join(" ")} Change the PO first, or the main admin ${how === "send" ? "sends" : "marks"} it anyway with a reason.`,
      data: { poOverlap: found },
    });
  }
  if (!actor.isMainAdmin) throw forbid("Only the main admin can send a PO past a stock overlap.");
  if (reason.length < 5) throw new ORPCError("BAD_REQUEST", { message: "Say why it is OK to send it as it is." });
  return found;
}

/** After the PO is saved as sent: who went past the overlap, when, and why. */
export async function logPoOverride(poId: number, how: "send" | "mark_sent", override: SendOverride, found: string[], actor: PermActor) {
  if (!found.length || !override) return;
  const reason = override.reason.trim();
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
  await db.insert(schema.activityLog).values({
    jobId: po?.jobId ?? null,
    entityType: "purchase_order",
    entityId: poId,
    action: "po_overlap_override",
    detail: `${po?.number ?? "PO"} ${how === "send" ? "sent" : "marked sent"} past a stock overlap. Reason: ${reason.slice(0, 500)}. Overlap: ${found.join(" ")}`.slice(0, 2000),
    actorName: actor.name,
    actorRole: actor.role,
  });
}
