import { ORPCError } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { forbid, type PermActor } from "./stock/core";

/* ---------------------------------------------------------------------------
 * Wrong product on a PO (Damien, 11 Nov, job 188065).
 *
 * A goods line on a job PO must be a product the client agreed to: the
 * accepted quote, an approved or invoiced variation, a colour the client
 * picked on the material selection form, or a substitute the main admin
 * approved with a reason. Identity is the product id, never a similar name
 * or price. The same brand, range and colour from another supplier counts as
 * the same product (an alternative supplier), shown but never blocked.
 *
 * Only the products are compared. A PO may order part of the quote, or one
 * supplier's share, so quantities and missing lines are never a mismatch.
 *
 * Drafts may be saved with a mismatch (they are internal). Send and Mark sent
 * stop until the PO is corrected, or the main admin approves the substitute
 * with a reason. That approval is written to the activity log against the
 * job and is what later checks read, so it is asked once.
 * ------------------------------------------------------------------------- */

export type SubstituteOverride = { reason: string } | null | undefined;

type Agreed = {
  /** False: no accepted quote on the job yet, or one with no catalogue products (warehouse work, or a job raised or priced by hand). Nothing is checked. */
  checked: boolean;
  ids: Map<number, string>;
  keys: Map<string, number>;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Brand, range and colour. Null when the range or colour is blank, so blanks never match each other. */
function identityKey(p: { brand: string; range: string; colour: string } | undefined) {
  if (!p || !norm(p.range) || !norm(p.colour)) return null;
  return `${norm(p.brand)}|${norm(p.range)}|${norm(p.colour)}`;
}

const SUB_TAG = /\[substitute:(\d+)\]/;

/** What the client agreed to on this job, by product id. */
export async function agreedProducts(jobId: number): Promise<Agreed> {
  const ids = new Map<number, string>();
  const accepted = await db
    .select({ id: schema.quotes.id })
    .from(schema.quotes)
    .where(and(eq(schema.quotes.jobId, jobId), eq(schema.quotes.status, "accepted")));
  if (!accepted.length) return { checked: false, ids, keys: new Map() };
  const items = await db
    .select({ productId: schema.quoteItems.productId })
    .from(schema.quoteItems)
    .where(inArray(schema.quoteItems.quoteId, accepted.map((q) => q.id)));
  for (const i of items) if (i.productId != null) ids.set(i.productId, "accepted quote");
  // A quote priced by hand, with no catalogue products on it, gives nothing to compare against.
  if (!ids.size) return { checked: false, ids, keys: new Map() };

  const vars = await db
    .select({ id: schema.variations.id })
    .from(schema.variations)
    .where(and(eq(schema.variations.jobId, jobId), inArray(schema.variations.status, ["approved", "invoiced"])));
  if (vars.length) {
    const vi = await db
      .select({ productId: schema.variationItems.productId })
      .from(schema.variationItems)
      .where(inArray(schema.variationItems.variationId, vars.map((v) => v.id)));
    for (const i of vi) if (i.productId != null && !ids.has(i.productId)) ids.set(i.productId, "approved variation");
  }

  const sels = await db
    .select({ id: schema.materialSelections.id })
    .from(schema.materialSelections)
    .where(and(eq(schema.materialSelections.jobId, jobId), eq(schema.materialSelections.status, "submitted")));
  if (sels.length) {
    const si = await db
      .select({ productId: schema.materialSelectionItems.productId })
      .from(schema.materialSelectionItems)
      .where(inArray(schema.materialSelectionItems.selectionId, sels.map((s) => s.id)));
    for (const i of si) if (i.productId != null && !ids.has(i.productId)) ids.set(i.productId, "client's colour pick");
  }

  const subs = await db
    .select({ detail: schema.activityLog.detail })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.jobId, jobId), eq(schema.activityLog.action, "product_substitute_approved")));
  for (const s of subs) {
    const m = SUB_TAG.exec(s.detail ?? "");
    if (m && !ids.has(Number(m[1]))) ids.set(Number(m[1]), "approved substitute");
  }

  const prods = ids.size ? await db.select().from(schema.products).where(inArray(schema.products.id, [...ids.keys()])) : [];
  const keys = new Map<string, number>();
  for (const p of prods) {
    const k = identityKey(p);
    if (k && !keys.has(k)) keys.set(k, p.id);
  }
  return { checked: true, ids, keys };
}

export type IdentityIssue = { lineId: number | null; productId: number; description: string; text: string };

async function productNames(ids: number[]) {
  if (!ids.length) return new Map<number, typeof schema.products.$inferSelect>();
  const rows = await db.select().from(schema.products).where(inArray(schema.products.id, ids));
  return new Map(rows.map((p) => [p.id, p]));
}

function nameOf(p: typeof schema.products.$inferSelect | undefined, fallback: string) {
  if (!p) return fallback;
  return [p.brand, p.range, p.colour ? `in ${p.colour}` : ""].filter(Boolean).join(" ").trim() || fallback;
}

/** The accepted quote's own goods, named, for the warning text. */
async function quotedNames(agreed: Agreed) {
  const ids = [...agreed.ids.entries()].filter(([, src]) => src === "accepted quote").map(([id]) => id);
  const names = await productNames(ids);
  return ids.map((id) => nameOf(names.get(id), `product ${id}`));
}

/**
 * Lines to check against the job's agreement. Each has a product id; lines
 * typed by hand with no product cannot be checked and are left alone.
 */
export async function identityIssues(jobId: number | null, lines: { id?: number | null; kind: string; productId: number | null; description: string }[]): Promise<IdentityIssue[]> {
  if (jobId == null) return [];
  const goods = lines.filter((l) => l.kind === "goods" && l.productId != null);
  if (!goods.length) return [];
  const agreed = await agreedProducts(jobId);
  if (!agreed.checked) return [];
  const names = await productNames([...new Set(goods.map((g) => g.productId!))]);
  const out: IdentityIssue[] = [];
  let quoted: string[] | null = null;
  for (const g of goods) {
    if (agreed.ids.has(g.productId!)) continue;
    const k = identityKey(names.get(g.productId!));
    if (k && agreed.keys.has(k)) continue;
    quoted ??= await quotedNames(agreed);
    const name = nameOf(names.get(g.productId!), g.description);
    out.push({
      lineId: g.id ?? null,
      productId: g.productId!,
      description: g.description,
      text: `${name} is not on the accepted quote or an approved change.${quoted.length ? ` The client agreed to ${quoted.join(", ")}.` : ""}`,
    });
  }
  return out;
}

/** Lines on a saved PO that are not what the client agreed to. Cancelled POs are history and never checked. */
export async function poIdentityIssues(poId: number): Promise<IdentityIssue[]> {
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
  if (!po || po.status === "cancelled" || po.jobId == null) return [];
  const lines = await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, poId));
  return identityIssues(po.jobId, lines);
}

/**
 * Called by Send and Mark sent, before the stock overlap check. Throws while
 * a line is a product the client did not agree to, unless the main admin
 * approves it as a substitute with a reason. Nothing is written here.
 */
export async function assertPoIdentity(poId: number, how: "send" | "mark_sent", override: SubstituteOverride, actor: PermActor) {
  const found = await poIdentityIssues(poId);
  if (!found.length) return [];
  const reason = override?.reason?.trim() ?? "";
  if (!override) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Product mismatch. ${found.map((f) => f.text).join(" ")} Change the PO to the agreed product, or the main admin approves the substitute with a reason.`,
      data: { poSubstitute: found.map((f) => f.text) },
    });
  }
  if (!actor.isMainAdmin) throw forbid("Only the main admin can approve a substitute product.");
  if (reason.length < 5) throw new ORPCError("BAD_REQUEST", { message: `Say why this substitute is OK before it is ${how === "send" ? "sent" : "marked sent"}.` });
  return found;
}

/** After the PO counts as sent: the substitute is approved on the job, with who, when and why. */
export async function logSubstitutes(poId: number, how: "send" | "mark_sent", override: SubstituteOverride, found: IdentityIssue[], actor: PermActor) {
  if (!found.length || !override) return;
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
  if (!po?.jobId) return;
  const reason = override.reason.trim().slice(0, 500);
  const seen = new Set<number>();
  for (const f of found) {
    if (seen.has(f.productId)) continue;
    seen.add(f.productId);
    await db.insert(schema.activityLog).values({
      jobId: po.jobId,
      entityType: "purchase_order",
      entityId: poId,
      action: "product_substitute_approved",
      detail: `Substitute approved on ${po.number} (${how === "send" ? "sent" : "marked sent"}): ${f.description}. ${f.text} Reason: ${reason} [substitute:${f.productId}]`.slice(0, 2000),
      actorName: actor.name,
      actorRole: actor.role,
    });
  }
}
