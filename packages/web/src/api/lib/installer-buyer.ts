import { ORPCError } from "@orpc/server";
import { and, eq, inArray, ne, notInArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { createContact } from "../routes/contacts";

/* ---------------------------------------------------------------------------
 * Task H (Damien, 29 Oct): an installer who also buys materials from Terra.
 *
 * One installer is billed as one existing contact or company. Ops suggests
 * records that look like him (ABN, name, email, mobile) and a person confirms
 * they are the same legal person or business:
 *   - a company with the same ABN: confirm with a tick (basis abn_match)
 *   - anything else: confirm with a tick and a reason (basis confirmed)
 *   - nothing there: make one from his card, once (basis created)
 * Ops never links by itself and never merges or edits either record.
 * The link gives his own login nothing. His profile stays field, and every
 * route here is office or admin only.
 * ------------------------------------------------------------------------- */

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const mob = (s: string | null | undefined) => digits(s).slice(-9);
const low = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

export type BuyerRef = { type: "contact" | "company"; id: number };
export type Candidate = BuyerRef & {
  name: string;
  abn: string | null;
  email: string | null;
  mobile: string | null;
  /** Why Ops thinks it may be him. */
  reasons: string[];
  abnMatch: boolean;
  /** Linked to another installer already. Can not be picked. */
  linkedTo: { installerId: number; name: string } | null;
};

async function installerOr404(id: number) {
  const [i] = await db.select().from(schema.installers).where(eq(schema.installers.id, id));
  if (!i) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });
  return i;
}

/** Names he trades or is registered under. */
function namesOf(i: typeof schema.installers.$inferSelect) {
  const out = new Set<string>();
  for (const n of [i.name, i.fullName, i.tradingName, i.abnLegalName]) if (low(n)) out.add(low(n));
  try {
    const extra = JSON.parse(i.abnBusinessNames ?? "[]");
    if (Array.isArray(extra)) for (const n of extra) if (typeof n === "string" && low(n)) out.add(low(n));
  } catch {
    for (const n of (i.abnBusinessNames ?? "").split(/[;,\n]/)) if (low(n)) out.add(low(n));
  }
  return out;
}

export async function buyerLinkOf(installerId: number) {
  const [l] = await db.select().from(schema.installerBuyerLinks).where(eq(schema.installerBuyerLinks.installerId, installerId));
  return l ?? null;
}

/** The record a link bills, as a Bill to. */
export function billToOfLink(l: typeof schema.installerBuyerLinks.$inferSelect): BuyerRef {
  return l.billToType === "company" ? { type: "company", id: l.companyId! } : { type: "contact", id: l.contactId! };
}

/** Records that may be him, best first. Read only. */
export async function buyerCandidates(installerId: number) {
  const i = await installerOr404(installerId);
  const abn = digits(i.abn);
  const names = namesOf(i);
  const emails = new Set([low(i.invoiceEmail), low(i.email)].filter(Boolean));
  const mobile = mob(i.mobile);

  const links = await db.select().from(schema.installerBuyerLinks);
  const linkNames = new Map((await db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers)).map((r) => [r.id, r.name]));
  const linkedTo = (ref: BuyerRef) => {
    const l = links.find((x) => (ref.type === "company" ? x.companyId === ref.id : x.contactId === ref.id));
    return l && l.installerId !== installerId ? { installerId: l.installerId, name: linkNames.get(l.installerId) ?? `Installer ${l.installerId}` } : null;
  };

  const out: Candidate[] = [];
  const companies = await db
    .select({ id: schema.companies.id, name: schema.companies.name, abn: schema.companies.abn, email: schema.companies.email, phone: schema.companies.phone })
    .from(schema.companies);
  for (const c of companies) {
    const reasons: string[] = [];
    const abnMatch = abn.length === 11 && digits(c.abn) === abn;
    if (abnMatch) reasons.push("Same ABN");
    if (names.has(low(c.name))) reasons.push("Same name");
    if (low(c.email) && emails.has(low(c.email))) reasons.push("Same email");
    if (mobile && mob(c.phone) === mobile) reasons.push("Same mobile");
    if (!reasons.length) continue;
    const ref = { type: "company" as const, id: c.id };
    out.push({ ...ref, name: c.name, abn: c.abn, email: c.email, mobile: c.phone, reasons, abnMatch, linkedTo: linkedTo(ref) });
  }
  const contacts = await db
    .select({ id: schema.contacts.id, first: schema.contacts.firstName, last: schema.contacts.lastName, email: schema.contacts.email, mobile: schema.contacts.mobile, active: schema.contacts.active })
    .from(schema.contacts);
  for (const c of contacts) {
    const name = `${c.first} ${c.last}`.trim();
    const reasons: string[] = [];
    if (names.has(low(name))) reasons.push("Same name");
    if (low(c.email) && emails.has(low(c.email))) reasons.push("Same email");
    if (mobile && mob(c.mobile) === mobile) reasons.push("Same mobile");
    if (!reasons.length) continue;
    const ref = { type: "contact" as const, id: c.id };
    out.push({ ...ref, name, abn: null, email: c.email, mobile: c.mobile, reasons, abnMatch: false, linkedTo: linkedTo(ref) });
  }
  out.sort((a, b) => Number(b.abnMatch) - Number(a.abnMatch) || b.reasons.length - a.reasons.length || a.name.localeCompare(b.name));
  return {
    installer: {
      id: i.id,
      name: i.name,
      fullName: i.fullName,
      tradingName: i.tradingName,
      legalName: i.abnLegalName,
      abn: i.abn,
      abnStatus: i.abnStatus,
      email: i.invoiceEmail ?? i.email,
      mobile: i.mobile,
      address: i.businessAddress,
    },
    link: await buyerLinkOf(installerId),
    candidates: out.slice(0, 20),
  };
}

async function buyerFacts(ref: BuyerRef) {
  if (ref.type === "company") {
    const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, ref.id));
    if (!c) throw bad("That company is gone.");
    return { name: c.name, abn: c.abn };
  }
  const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, ref.id));
  if (!c) throw bad("That contact is gone.");
  return { name: `${c.firstName} ${c.lastName}`.trim(), abn: null as string | null };
}

async function logInstaller(installerId: number, action: string, detail: string, actor: Pick<Actor, "name" | "role">, contactId?: number | null) {
  await db.insert(schema.activityLog).values({ entityType: "installer", entityId: installerId, contactId: contactId ?? null, action, detail, actorName: actor.name, actorRole: actor.role });
}

/**
 * Link an installer to an existing contact or company. Same ABN needs the tick.
 * Anything else needs the tick and a reason. Refuses if either side is linked.
 */
export async function linkBuyer(
  input: { installerId: number; buyer: BuyerRef; sameEntity: true; reason?: string | null },
  actor: Pick<Actor, "name" | "role" | "userId">,
) {
  const i = await installerOr404(input.installerId);
  if (!input.sameEntity) throw bad("Tick that they are the same legal person or business first.");
  const existing = await buyerLinkOf(i.id);
  if (existing) throw bad(`${i.name} is already billed as ${existing.buyerName}. Unlink that first.`);
  const facts = await buyerFacts(input.buyer);
  const [other] = await db
    .select({ installerId: schema.installerBuyerLinks.installerId })
    .from(schema.installerBuyerLinks)
    .where(input.buyer.type === "company" ? eq(schema.installerBuyerLinks.companyId, input.buyer.id) : eq(schema.installerBuyerLinks.contactId, input.buyer.id));
  if (other) throw bad(`${facts.name} is already linked to another installer.`);

  const abn = digits(i.abn);
  const abnMatch = input.buyer.type === "company" && abn.length === 11 && digits(facts.abn) === abn;
  const reason = (input.reason ?? "").trim();
  if (!abnMatch && reason.length < 8) {
    throw bad("The ABNs do not match, so say how you know it is the same person or business (at least a few words).");
  }
  if (input.buyer.type === "company" && digits(facts.abn) && abn && digits(facts.abn) !== abn) {
    throw bad(`${facts.name} has a different ABN (${facts.abn}) from ${i.name} (${i.abn}). They are not the same business.`);
  }
  const basis = abnMatch ? "abn_match" : "confirmed";
  const [row] = await db
    .insert(schema.installerBuyerLinks)
    .values({
      installerId: i.id,
      billToType: input.buyer.type,
      contactId: input.buyer.type === "contact" ? input.buyer.id : null,
      companyId: input.buyer.type === "company" ? input.buyer.id : null,
      basis,
      reason: reason || null,
      installerAbn: i.abn,
      installerLegalName: i.abnLegalName ?? i.fullName ?? i.name,
      buyerName: facts.name,
      buyerAbn: facts.abn,
      confirmedByName: actor.name,
      confirmedByUserId: actor.userId,
      confirmedAt: new Date(),
    })
    .returning();
  await logInstaller(
    i.id,
    "buyer_linked",
    `${i.name} is billed as ${facts.name} (${input.buyer.type}). ${abnMatch ? "Same ABN, confirmed" : `Confirmed: ${reason}`}.`,
    actor,
    input.buyer.type === "contact" ? input.buyer.id : null,
  );
  return row!;
}

/** No record for him yet: make one from his card, once, and link it. */
export async function createBuyerFromInstaller(
  input: { installerId: number; as: "company" | "contact"; name: string; noneOfThese: boolean },
  actor: Pick<Actor, "name" | "role" | "userId">,
) {
  const i = await installerOr404(input.installerId);
  if (await buyerLinkOf(i.id)) throw bad(`${i.name} is already linked. Unlink first.`);
  const { candidates } = await buyerCandidates(i.id);
  const abnHit = candidates.find((c) => c.abnMatch && !c.linkedTo);
  if (abnHit) throw bad(`${abnHit.name} already has his ABN. Link that one instead of making another.`);
  if (candidates.some((c) => !c.linkedTo) && !input.noneOfThese) throw bad("Ops found records that may be him. Link one, or tick that none of them is him.");
  const name = input.name.replace(/\s+/g, " ").trim();
  if (name.length < 2) throw bad("Type the name to bill.");
  const email = i.invoiceEmail ?? i.email ?? null;
  let ref: BuyerRef;
  if (input.as === "company") {
    const [c] = await db
      .insert(schema.companies)
      .values({ name, abn: i.abn, type: "other", email, phone: i.mobile, billingAddress: i.businessAddress, depositPercent: 0, notes: `Made from installer ${i.name}'s card (installer ${i.id}).` })
      .returning();
    ref = { type: "company", id: c!.id };
  } else {
    const parts = name.split(" ");
    const c = await createContact(
      { firstName: parts[0]!, lastName: parts.slice(1).join(" "), mobile: i.mobile, email, address: i.businessAddress, source: "other", notes: `Made from installer ${i.name}'s card (installer ${i.id}).` },
      actor,
    );
    await db.update(schema.contacts).set({ depositPercent: 0 }).where(eq(schema.contacts.id, c!.id));
    ref = { type: "contact", id: c!.id };
  }
  const [row] = await db
    .insert(schema.installerBuyerLinks)
    .values({
      installerId: i.id,
      billToType: ref.type,
      contactId: ref.type === "contact" ? ref.id : null,
      companyId: ref.type === "company" ? ref.id : null,
      basis: "created",
      reason: input.noneOfThese ? "Made from his card. None of the suggested records was him." : "Made from his card. No record looked like him.",
      installerAbn: i.abn,
      installerLegalName: i.abnLegalName ?? i.fullName ?? i.name,
      buyerName: name,
      buyerAbn: input.as === "company" ? i.abn : null,
      confirmedByName: actor.name,
      confirmedByUserId: actor.userId,
      confirmedAt: new Date(),
    })
    .returning();
  await logInstaller(i.id, "buyer_created", `${i.name} is billed as ${name} (${ref.type}, new, made from his card).`, actor, ref.type === "contact" ? ref.id : null);
  return row!;
}

/** Remove the link. Both records stay. Refused while a contra is open on it. */
export async function unlinkBuyer(input: { installerId: number; reason: string }, actor: Pick<Actor, "name" | "role">) {
  const l = await buyerLinkOf(input.installerId);
  if (!l) throw bad("He is not linked.");
  if ((input.reason ?? "").trim().length < 4) throw bad("Say why it is being unlinked.");
  const open = await db
    .select({ id: schema.xeroContras.id })
    .from(schema.xeroContras)
    .where(and(eq(schema.xeroContras.installerId, input.installerId), notInArray(schema.xeroContras.status, ["confirmed", "cancelled"])));
  if (open.length) throw bad("A contra for him is still open. Finish or cancel it first.");
  await db.delete(schema.installerBuyerLinks).where(eq(schema.installerBuyerLinks.id, l.id));
  await logInstaller(input.installerId, "buyer_unlinked", `No longer billed as ${l.buyerName}. ${input.reason.trim()}`, actor);
  return { ok: true };
}

/** Ops client invoices billed to his linked record: what he owes Terra. */
export async function invoicesForLink(l: typeof schema.installerBuyerLinks.$inferSelect) {
  const ref = billToOfLink(l);
  const rows = await db
    .select()
    .from(schema.invoices)
    .where(
      and(
        ref.type === "company" ? eq(schema.invoices.billToCompanyId, ref.id) : eq(schema.invoices.billToContactId, ref.id),
        eq(schema.invoices.billToType, ref.type),
        ne(schema.invoices.status, "draft"),
      ),
    );
  return rows;
}

/** His contractor bills in Ops that are not paid: what Terra owes him. */
export async function openInstallerBills(installerId: number) {
  return db
    .select()
    .from(schema.installerInvoices)
    .where(and(eq(schema.installerInvoices.installerId, installerId), inArray(schema.installerInvoices.status, ["submitted", "approved", "scheduled_for_payment"])));
}

