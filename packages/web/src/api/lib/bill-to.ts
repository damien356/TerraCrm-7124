import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { rebuildForecast } from "./cashflow";
import { syncJobValue } from "./job-value";

/* ---------------------------------------------------------------------------
 * Bill to (notes 18.54, Damien 16 Oct).
 *
 *   Every job and every quote has a Bill to: one company or one person.
 *   Each quote has its own, and it can differ from the job's.
 *   The deposit % lives on the Bill to's card. A quote takes it from there,
 *   and can be typed over for that one quote without touching the card.
 *   A card with no % is never guessed: the office is asked, it saves on the
 *   card, and the quote can't go out until it has one.
 *   A card getting or changing its % updates the draft quotes billed to it
 *   (the ones following the card). Sent quotes stay as they are.
 * ------------------------------------------------------------------------- */

const DRAFT = ["draft", "needs_review"];

export const billToInput = z.object({ type: z.enum(["contact", "company"]), id: z.number().int().positive() });
export type BillTo = z.infer<typeof billToInput>;

type Billable = { billToType: string | null; billToContactId: number | null; billToCompanyId: number | null };

/** The three columns a Bill to is stored in, on a job, quote or invoice. */
export function billToFields(b: BillTo | null) {
  return {
    billToType: b?.type ?? null,
    billToContactId: b?.type === "contact" ? b.id : null,
    billToCompanyId: b?.type === "company" ? b.id : null,
  };
}

/** A quote's own Bill to, or null when it has none yet. */
export function quoteBillTo(q: Billable): BillTo | null {
  if (q.billToType === "company" && q.billToCompanyId) return { type: "company", id: q.billToCompanyId };
  if (q.billToType === "contact" && q.billToContactId) return { type: "contact", id: q.billToContactId };
  return null;
}

/** A job's Bill to, with the same fallbacks the invoices use (lib/final-invoice.ts). */
export function jobBillTo(job: Billable & { contactId: number | null; companyId: number | null }): BillTo | null {
  if (job.billToType === "company") {
    const id = job.billToCompanyId ?? job.companyId;
    return id ? { type: "company", id } : null;
  }
  const id = job.billToContactId ?? job.contactId;
  return id ? { type: "contact", id } : null;
}

/** Who a new quote bills when the caller did not say: its job's Bill to, else the company, else the person. */
export async function defaultQuoteBillTo(args: { jobId?: number | null; companyId?: number | null; contactId?: number | null }): Promise<BillTo | null> {
  if (args.jobId) {
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, args.jobId));
    const b = job ? jobBillTo(job) : null;
    if (b) return b;
  }
  if (args.companyId) return { type: "company", id: args.companyId };
  if (args.contactId) return { type: "contact", id: args.contactId };
  return null;
}

/**
 * The company named on a quote's paperwork. A quote billed to a company names
 * it, one billed to a person names no company (their private job), and an
 * older quote with no Bill to keeps its company.
 */
export function billedCompanyId(q: Billable & { companyId: number | null }) {
  if (q.billToType === "company") return q.billToCompanyId ?? q.companyId;
  if (q.billToType === "contact") return null;
  return q.companyId;
}

export type Card = { type: BillTo["type"]; id: number; name: string; percent: number | null };

/** The card behind a Bill to: its name and deposit %. Null when the card is gone. */
export async function cardOf(b: BillTo | null): Promise<Card | null> {
  if (!b) return null;
  if (b.type === "company") {
    const [c] = await db
      .select({ name: schema.companies.name, percent: schema.companies.depositPercent })
      .from(schema.companies)
      .where(eq(schema.companies.id, b.id));
    return c ? { type: "company", id: b.id, name: c.name, percent: c.percent } : null;
  }
  const [p] = await db
    .select({ first: schema.contacts.firstName, last: schema.contacts.lastName, percent: schema.contacts.depositPercent })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, b.id));
  return p ? { type: "contact", id: b.id, name: `${p.first ?? ""} ${p.last ?? ""}`.trim() || "This person", percent: p.percent } : null;
}

export async function assertCard(b: BillTo) {
  const card = await cardOf(b);
  if (!card) throw new ORPCError("BAD_REQUEST", { message: b.type === "company" ? "That company is gone. Pick who pays again." : "That person is gone. Pick who pays again." });
  return card;
}

/**
 * The deposit columns for a quote billed to this card. A typed % that differs
 * from the card is for this quote only. No typed % and no card % means asked.
 */
export function depositFieldsFor(card: Card | null, typed?: number | null) {
  if (typed != null) return { depositPercent: typed, depositSource: card?.percent === typed ? "card" : "quote" };
  if (card?.percent != null) return { depositPercent: card.percent, depositSource: "card" };
  return { depositPercent: 0, depositSource: "none" };
}

/**
 * A card got or changed its %. Every draft quote billed to it that follows
 * the card (or was waiting for a %) takes the new figure. Typed ones and
 * anything sent stay. Returns how many quotes changed.
 */
export async function cardDepositChanged(b: BillTo) {
  const card = await cardOf(b);
  if (!card) return 0;
  const col = b.type === "company" ? schema.quotes.billToCompanyId : schema.quotes.billToContactId;
  const rows = await db
    .select({ id: schema.quotes.id, jobId: schema.quotes.jobId, pct: schema.quotes.depositPercent, src: schema.quotes.depositSource })
    .from(schema.quotes)
    .where(
      and(
        eq(schema.quotes.billToType, b.type),
        eq(col, b.id),
        inArray(schema.quotes.status, DRAFT),
        inArray(schema.quotes.depositSource, ["card", "none"]),
      ),
    );
  const next = depositFieldsFor(card);
  const changed = rows.filter((r) => r.pct !== next.depositPercent || r.src !== next.depositSource);
  if (changed.length) {
    await db
      .update(schema.quotes)
      .set({ ...next, updatedAt: new Date() })
      .where(inArray(schema.quotes.id, changed.map((r) => r.id)));
    for (const jobId of new Set(changed.map((r) => r.jobId).filter((x): x is number => !!x))) await syncJobValue(jobId);
  }
  return changed.length;
}

/**
 * Save a % on a card (the Deposit % to fill page, and the ask on a quote or
 * job). A company's payment terms row keeps in step, the same as saving it
 * on the company card, and the forecast is redone.
 */
export async function setCardDeposit(b: BillTo, percent: number | null, actor: { name: string; role: string }) {
  const card = await assertCard(b);
  if (b.type === "company") {
    await db.update(schema.companies).set({ depositPercent: percent, updatedAt: new Date() }).where(eq(schema.companies.id, b.id));
    await syncCompanyTerms(b.id, percent);
  } else {
    await db.update(schema.contacts).set({ depositPercent: percent, updatedAt: new Date() }).where(eq(schema.contacts.id, b.id));
  }
  const quotes = await cardDepositChanged(b);
  await db.insert(schema.activityLog).values({
    contactId: b.type === "contact" ? b.id : null,
    entityType: b.type,
    entityId: b.id,
    action: "deposit_set",
    detail: `Deposit on ${card.name}'s card ${percent == null ? "cleared" : `set to ${percent}%`}${quotes ? `, ${quotes} draft quote${quotes === 1 ? "" : "s"} updated` : ""}`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  await rebuildForecast().catch((e) => console.error("[cashflow] rebuild after deposit change failed:", e));
  return { ...card, percent, quotesUpdated: quotes };
}

/** A company's payment terms row follows its card %. Progress claims carry their own stages and are left alone. */
export async function syncCompanyTerms(companyId: number, percent: number | null) {
  const pct = percent ?? 0;
  await db
    .update(schema.paymentTerms)
    .set({ depositPercent: pct, structure: pct > 0 ? "deposit_balance" : "on_completion", updatedAt: new Date() })
    .where(and(eq(schema.paymentTerms.companyId, companyId), ne(schema.paymentTerms.structure, "progress_claims")));
}

/**
 * Send, Accept and Convert check this (via assertReadyToGoOut): the quote has
 * a Bill to whose card is still there, and a deposit % (typed or from the
 * card). A quote that was waiting while its card got a % takes it here.
 */
export async function assertBillToReady(q: typeof schema.quotes.$inferSelect) {
  const b = quoteBillTo(q);
  if (!b) throw new ORPCError("BAD_REQUEST", { message: "Pick who pays this quote (Bill to) first." });
  const card = await assertCard(b);
  if (q.depositSource !== "none") return;
  if (card.percent == null) {
    throw new ORPCError("BAD_REQUEST", { message: `${card.name} has no deposit % yet. Type it on the quote first. It saves on their card.` });
  }
  await db.update(schema.quotes).set({ ...depositFieldsFor(card), updatedAt: new Date() }).where(eq(schema.quotes.id, q.id));
  Object.assign(q, depositFieldsFor(card));
  if (q.jobId) await syncJobValue(q.jobId);
}

/** Job statuses that are finished or dead. Everything else is an open job. */
export const CLOSED_JOB_STATUS_NAMES = ["complete", "completed", "invoiced", "paid", "cancelled", "lost", "archived", "declined"];

/**
 * The Deposit % to fill page: every card with no % that pays on an open job,
 * either as the job's Bill to or as the Bill to of a draft or sent quote on it.
 */
export async function cardsMissingDeposit() {
  const closed = sql.join(CLOSED_JOB_STATUS_NAMES.map((n) => sql`${n}`), sql`, `);
  const rows = await db.all<{ type: "company" | "contact"; id: number; job_id: number; job_ref: string; title: string | null }>(sql`
    with open_jobs as (
      select j.* from jobs j left join job_statuses s on s.id = j.status_id
      where lower(trim(coalesce(s.name, ''))) not in (${closed})
    ),
    payers as (
      select case when j.bill_to_type = 'company' then 'company' else 'contact' end as type,
             case when j.bill_to_type = 'company' then coalesce(j.bill_to_company_id, j.company_id) else coalesce(j.bill_to_contact_id, j.contact_id) end as id,
             j.id as job_id
      from open_jobs j
      union
      select q.bill_to_type, coalesce(q.bill_to_company_id, q.bill_to_contact_id), q.job_id
      from quotes q join open_jobs j on j.id = q.job_id
      where q.bill_to_type is not null and q.status in ('draft', 'needs_review', 'sent')
    )
    select p.type, p.id, p.job_id, coalesce(j.display_number, cast(j.number as text)) as job_ref, j.title
    from payers p join jobs j on j.id = p.job_id
    left join companies co on p.type = 'company' and co.id = p.id
    left join contacts ct on p.type = 'contact' and ct.id = p.id
    where p.id is not null
      and ((p.type = 'company' and co.id is not null and co.deposit_percent is null)
        or (p.type = 'contact' and ct.id is not null and ct.deposit_percent is null))
    order by p.type, p.id, j.number`);
  const byCard = new Map<string, { type: "company" | "contact"; id: number; jobs: Array<{ id: number; ref: string; title: string | null }> }>();
  for (const r of rows) {
    const key = `${r.type}:${r.id}`;
    const card = byCard.get(key) ?? { type: r.type, id: r.id, jobs: [] };
    if (!card.jobs.some((j) => j.id === r.job_id)) card.jobs.push({ id: r.job_id, ref: r.job_ref, title: r.title });
    byCard.set(key, card);
  }
  const cards = [...byCard.values()];
  const companyIds = cards.filter((c) => c.type === "company").map((c) => c.id);
  const contactIds = cards.filter((c) => c.type === "contact").map((c) => c.id);
  const companies = companyIds.length
    ? await db.select({ id: schema.companies.id, name: schema.companies.name, kind: schema.companies.type }).from(schema.companies).where(inArray(schema.companies.id, companyIds))
    : [];
  const people = contactIds.length
    ? await db
        .select({ id: schema.contacts.id, first: schema.contacts.firstName, last: schema.contacts.lastName, email: schema.contacts.email, mobile: schema.contacts.mobile })
        .from(schema.contacts)
        .where(inArray(schema.contacts.id, contactIds))
    : [];
  const coMap = new Map(companies.map((c) => [c.id, c]));
  const ctMap = new Map(people.map((c) => [c.id, c]));
  return cards
    .map((c) => {
      const co = c.type === "company" ? coMap.get(c.id) : undefined;
      const ct = c.type === "contact" ? ctMap.get(c.id) : undefined;
      return {
        ...c,
        name: co?.name ?? (`${ct?.first ?? ""} ${ct?.last ?? ""}`.trim() || "No name"),
        detail: co ? co.kind.replace(/_/g, " ") : [ct?.mobile, ct?.email].filter(Boolean).join(" · "),
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "company" ? -1 : 1));
}

/**
 * Put a Bill to on a quote. A draft that follows the card (or was waiting
 * for a %) takes the new card's figure. A typed % stays, unless fromCard
 * says to follow the card again. Returns the updated quote.
 */
export async function quoteBillToPatch(quoteId: number, b: BillTo | null, typed?: number, fromCard?: boolean) {
  const [q] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!q) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
  const card = b ? await assertCard(b) : null;
  const patch: Partial<typeof schema.quotes.$inferInsert> = billToFields(b);
  if (typed != null) Object.assign(patch, depositFieldsFor(card, typed));
  else if (DRAFT.includes(q.status) && (fromCard || q.depositSource !== "quote")) Object.assign(patch, depositFieldsFor(card));
  const [row] = await db.update(schema.quotes).set({ ...patch, updatedAt: new Date() }).where(eq(schema.quotes.id, quoteId)).returning();
  if (q.jobId) await syncJobValue(q.jobId);
  return row ?? q;
}
