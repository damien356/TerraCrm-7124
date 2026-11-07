import { ORPCError } from "@orpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { assertBillable } from "./callbacks";
import { depositInvoiceFor, raiseInvoice, type InvoiceRow } from "./client-invoices";
import { depositSplit, quotePercent } from "./deposits";
import { carryQuotePeopleToJob } from "./job-people";
import { moveJobForward } from "./job-stage";
import { notifyOffice } from "./notify";
import { buildWorkFromQuote, convertQuoteToJob } from "./quote-convert";
import { assertDefaultsResolved } from "./quote-default-gate";
import { quoteRefOf } from "./quote-number";
import { doublesBeforeBuild, reworkJobForVersion, reworkSummary, workBaseQuoteId, type Rework } from "./quote-rework";
import { jobText } from "./refs";
import { approvedVariationsTotal } from "./variations";

/* ---------------------------------------------------------------------------
 * The one accept routine (spec section 2.3). Staff pressing Accepted and a
 * client signing online both come through here, so both do the same things:
 *
 *   lock the quote, make the job if there is none, job value = the quote,
 *   job to Won, other versions expire (an earlier accepted one is marked
 *   replaced), deposit invoice IQ{n}-1 at the quote's deposit %, or for a
 *   replacement a variation for the difference when it comes to more, and an
 *   Order product task. The material selection form is sent by the office
 *   from the job page, never by itself (fix list 13 Oct, item 10).
 *
 *   Dispatches and materials (item 7): made from the lines the first time a
 *   version is accepted on the job. A later version swaps over the free ones
 *   (lib/quote-rework.ts) and flags the rest to the office.
 * ------------------------------------------------------------------------- */

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

export type AcceptActor = { name: string; role: string };

/** What a customer sees when a container or stock-only product ran short after the quote went out. No stock details. */
export const ACCEPT_SHORT_CUSTOMER =
  "We could not accept this quote online just now because some of the material on it needs checking with our office. Nothing has been accepted or charged. We have let the office know and they will contact you.";

/**
 * A2 follow-up (Damien, 4 Nov): the container and stock-only check also runs
 * when the quote is accepted, not only when it is sent. Stock that was there
 * at send may have gone to another order since. The main admin's approval on
 * this quote (made at send, or now) carries over. Nothing on the quote
 * changes, nothing is ordered.
 */
async function acceptSupplyCheck(quote: typeof schema.quotes.$inferSelect, via: "staff" | "online") {
  const { assertSupplyOk, quoteSupplyLines } = await import("./stock/supply-check");
  try {
    await assertSupplyOk(await quoteSupplyLines(quote.id), quote.jobId, { entityType: "quote", entityKey: String(quote.id) });
  } catch (e) {
    const open = ((e as { data?: { supplyShort?: { productId: number; text: string }[] } }).data?.supplyShort ?? []).filter(Boolean);
    if (!open.length) throw e;
    const { stockAlert } = await import("./stock/alerts");
    const ref = await quoteRefOf(quote);
    for (const s of open) {
      await stockAlert(`accept-short:${quote.id}:${s.productId}`, "stock_accept_short", {
        jobId: quote.jobId,
        title: `${via === "online" ? "Customer tried to accept" : "Accept stopped"}: ${ref} is short`,
        body: `${s.text} ${via === "online" ? "The customer was told the office will contact them." : "Staff pressed Accepted."} The quote is not accepted and was not changed. No invoice, no purchase. Change the quote, or the main admin approves the shortage on the quote, then accept again.`,
        path: `/quotes/${quote.id}`,
      }).catch((err) => console.error("[stock] accept-short alert failed:", (err as Error).message));
    }
    if (via === "online") throw bad(ACCEPT_SHORT_CUSTOMER);
    throw e;
  }
}

export async function acceptQuote(args: { quoteId: number; actor: AcceptActor; via: "staff" | "online"; note?: string | null }) {
  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, args.quoteId));
  if (!quote) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
  if (quote.status === "accepted") throw bad("This quote is already accepted.");
  if (quote.status === "cancelled") throw bad("This quote has been cancelled. Ask us for a new one.");
  if (quote.status === "expired" || quote.status === "replaced") {
    throw bad("This version has been replaced by a newer one. Accept the current version.");
  }
  if (args.via === "online" && quote.status === "declined") throw bad("This quote was declined. Ask us for a new one.");
  if (args.via === "online" && quote.validUntil && quote.validUntil.getTime() < Date.now() - 86_400_000) {
    throw bad("This quote has passed its valid until date. Reply to our email and we will update it for you.");
  }
  await assertBillable(quote.jobId);
  // Quote defaults (7 Nov): an online accept does not go through assertReadyToGoOut, so the gate is here too.
  await assertDefaultsResolved(quote.id, args.via);
  await acceptSupplyCheck(quote, args.via);

  // Lock it, only if nobody else got there first.
  const now = new Date();
  const [locked] = await db
    .update(schema.quotes)
    .set({ status: "accepted", acceptedAt: now, updatedAt: now })
    .where(and(eq(schema.quotes.id, quote.id), eq(schema.quotes.status, quote.status)))
    .returning();
  if (!locked) throw bad("This quote just changed. Refresh and try again.");

  let jobId = locked.jobId;
  let converted = false;
  if (!jobId) {
    const made = await convertQuoteToJob(locked, {}, args.actor);
    jobId = made.job.id;
    converted = true;
  }
  const ref = await quoteRefOf({ ...locked, jobId });

  // An earlier accepted version of the same quote is now replaced.
  const previous = await db
    .select()
    .from(schema.quotes)
    .where(and(eq(schema.quotes.number, quote.number), eq(schema.quotes.status, "accepted"), sql`${schema.quotes.id} != ${quote.id}`));
  const prev = previous.sort((a, b) => b.version - a.version)[0] ?? null;
  if (previous.length) {
    await db
      .update(schema.quotes)
      .set({ status: "replaced", updatedAt: now })
      .where(inArray(schema.quotes.id, previous.map((p) => p.id)));
  }
  // Versions still on the table lose.
  await db
    .update(schema.quotes)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(schema.quotes.number, quote.number),
        inArray(schema.quotes.status, ["draft", "needs_review", "sent"]),
        sql`${schema.quotes.id} != ${quote.id}`,
      ),
    );

  // The job's value is the accepted price plus accepted variations (item 12).
  // The deposit is set by the first accept only.
  const variationsOn = await approvedVariationsTotal(jobId);
  await db
    .update(schema.jobs)
    .set({
      value: round2(locked.total + variationsOn),
      ...(prev ? {} : { depositAmount: depositSplit(locked.total, quotePercent(locked)).deposit }),
      updatedAt: now,
    })
    .where(eq(schema.jobs.id, jobId));
  if (!converted) await carryQuotePeopleToJob(locked.id, jobId);

  const prevRef = prev ? await quoteRefOf(prev) : null;
  await db.insert(schema.activityLog).values({
    jobId,
    contactId: locked.contactId,
    entityType: "quote",
    entityId: locked.id,
    action: "accepted",
    detail:
      args.note?.trim() ||
      `Quote ${ref} accepted${args.via === "online" ? ` online by ${args.actor.name}` : ""}, ${money(locked.total)}${prevRef ? `. Replaces ${prevRef}` : ""}`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
  await moveJobForward({ jobId, target: "won", why: `quote ${ref} accepted`, actor: args.actor });

  // Money: a deposit on a first accept, a variation for the difference on a replacement.
  let invoice: InvoiceRow | null = null;
  if (prev) {
    const diff = round2(locked.total - prev.total);
    if (diff > 0.005) {
      invoice = await raiseInvoice({
        jobId,
        quoteId: locked.id,
        kind: "variation",
        label: `Variation: quote ${ref} replaces ${prevRef}, ${money(prev.total)} to ${money(locked.total)}`,
        total: diff,
        createdByName: args.actor.name,
        actorRole: args.actor.role,
      });
    }
  } else if (quotePercent(locked) > 0 && !(await depositInvoiceFor(locked.id))) {
    const { deposit } = depositSplit(locked.total, quotePercent(locked));
    if (deposit > 0) {
      invoice = await raiseInvoice({
        jobId,
        quoteId: locked.id,
        kind: "deposit",
        label: `Deposit ${locked.depositPercent}% on quote ${ref}`,
        total: deposit,
        createdByName: args.actor.name,
        actorRole: args.actor.role,
      });
    }
  }

  // Sell products (Damien, 30 Oct): a product sale has nothing to install. Its
  // own ordering runs below instead of the dispatch, materials and Order product task.
  const { saleOfJob, saleQuoteAccepted } = await import("./product-sale");
  const isSale = !!(await saleOfJob(jobId));

  // Dispatches and materials. A new job already has them (convertQuoteToJob).
  let rework: Rework | null = null;
  let built: { tasksCreated: number; materialsCreated: number } | null = null;
  if (!converted && !isSale) {
    const base = await workBaseQuoteId(locked.number, jobId);
    if (base == null) {
      const doubles = await doublesBeforeBuild(locked.id, jobId);
      built = await buildWorkFromQuote(locked.id, jobId);
      if (doubles.length) {
        rework = { changes: [], flags: doubles, tasksAdded: 0, tasksUpdated: 0, tasksCancelled: 0, materialsAdded: 0, materialsUpdated: 0, materialsRemoved: 0 };
      }
      await db.insert(schema.activityLog).values({
        jobId,
        contactId: locked.contactId,
        entityType: "quote",
        entityId: locked.id,
        action: "work_made",
        detail: [
          `Made from quote ${ref}: ${built.tasksCreated} dispatch${built.tasksCreated === 1 ? "" : "es"}, ${built.materialsCreated} material${built.materialsCreated === 1 ? "" : "s"} to order`,
          ...doubles.map((f) => `To sort: ${f}`),
        ].join("\n"),
        actorName: args.actor.name,
        actorRole: args.actor.role,
      });
    } else if (base !== locked.id) {
      rework = await reworkJobForVersion({ jobId, fromQuoteId: base, toQuoteId: locked.id });
      await db.insert(schema.activityLog).values({
        jobId,
        contactId: locked.contactId,
        entityType: "quote",
        entityId: locked.id,
        action: "work_swapped",
        detail: [`Dispatches and materials moved to quote ${ref}: ${reworkSummary(rework)}.`, ...rework.changes, ...rework.flags.map((f) => `To sort: ${f}`)].join("\n"),
        actorName: args.actor.name,
        actorRole: args.actor.role,
      });
    }
  }

  // Timber repairs priced by Marc: the dispatch goes straight to him (notes 18.38).
  if (built?.tasksCreated) {
    const { afterRepairAccepted } = await import("./timber-repair");
    await afterRepairAccepted(locked.id, jobId, args.actor).catch((e) => console.error("[quote-accept] timber repair offer failed:", e));
  }

  // Warehouse stock (A1.2): an order with stock chosen gets its deposit terms
  // frozen now and is checked once. If this fails the background check picks
  // it up from the accepted quote. Never stops the accept.
  try {
    const { isLive } = await import("./stock/core");
    if (await isLive("s1")) {
      const { orderOfJob, syncTerms } = await import("./stock/orders");
      const o = await orderOfJob(jobId);
      if (o) {
        await syncTerms(o);
        const { recheckOrder } = await import("./stock/recheck");
        await recheckOrder(o.id);
      }
    }
  } catch (e) {
    console.error("[quote-accept] stock terms failed:", (e as Error).message);
  }

  // Step 2 (20 Oct): draft one PO per supplier for what is still to order.
  // Drafts only, never sent. A failure never stops the accept.
  const { draftPosForJob } = await import("./po-helper");
  const saleOut = isSale
    ? await saleQuoteAccepted({ jobId, quoteId: locked.id, quoteRef: ref, actor: args.actor }).catch((e) => {
        console.error("[quote-accept] product sale ordering failed:", e);
        return null;
      })
    : null;
  const drafts = isSale
    ? { drafted: saleOut?.pos ?? [], skipped: 0 }
    : await draftPosForJob({ jobId, quoteRef: ref }).catch((e) => {
        console.error("[quote-accept] PO helper failed:", e);
        return null;
      });

  // The Order product task. The material selection form is never sent by
  // itself (fix list 13 Oct, item 10): the office sends it from the job page.
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  const jobRef = job ? jobText(job) : String(jobId);

  const taskDetail = [
    prev
      ? `Quote ${ref} (${money(locked.total)}) replaced ${prevRef} (${money(prev.total)}). Check the product order still matches.`
      : `Quote ${ref} accepted, ${money(locked.total)}.`,
    invoice?.kind === "deposit" ? `Order once deposit ${invoice.number} (${money(invoice.total)}) is paid.` : "",
    invoice?.kind === "variation" ? `Variation ${invoice.number} raised for ${money(invoice.total)}.` : "",
    !prev && !invoice ? "No deposit on this quote. Raise the invoice from the job's Client invoices card when it is ready to bill." : "",
    !prev && !isSale ? "Send the material selection form from the job page so the client can check the colours before you order." : "",
    drafts?.drafted.length
      ? `Ops drafted ${drafts.drafted.length === 1 ? "PO" : "POs"} ${drafts.drafted.map((d) => d.number).join(", ")}. Not sent. Check and send from the job page.`
      : "",
    rework?.changes.length ? `Ops changed:\n${rework.changes.map((c) => `- ${c}`).join("\n")}` : "",
    rework?.flags.length ? `To sort by hand (crew have not been told):\n${rework.flags.map((f) => `- ${f}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  // A product sale only gets a task when it is being ordered: check and send the draft POs.
  const wantTask = !isSale || (!!saleOut?.ordered && !prev);
  const [task] = !wantTask
    ? []
    : await db
    .insert(schema.officeTasks)
    .values({
      jobId,
      title: rework?.flags.length
        ? `Sort ${rework.flags.length} thing${rework.flags.length === 1 ? "" : "s"} on job ${jobRef}, quote ${ref}`
        : prev
          ? `Check product order, job ${jobRef}`
          : isSale
            ? `Check draft POs for product sale, job ${jobRef}`
            : `Order product, job ${jobRef}`,
      detail: taskDetail,
      createdByName: args.actor.name,
    })
    .returning();

  // Anything Ops would not change on its own goes to the office straight away.
  if (rework?.flags.length) {
    const shown = rework.flags.slice(0, 4);
    const more = rework.flags.length - shown.length;
    await notifyOffice("quote_rework", {
      title: `Job ${jobRef}: ${rework.flags.length} thing${rework.flags.length === 1 ? "" : "s"} to sort after quote ${ref}`,
      body: [...shown, more > 0 ? `And ${more} more on the job.` : ""].filter(Boolean).join("\n"),
      data: { kind: "job", jobId },
    }).catch((e) => console.error("[quote-accept] flag push failed:", e));
  }

  if (args.via === "online") {
    await notifyOffice("quote_accepted", {
      title: `Quote ${ref} accepted online`,
      body: `${args.actor.name} accepted ${money(locked.total)}${invoice?.kind === "deposit" ? `. Deposit ${invoice.number} is waiting.` : "."}`,
      data: { kind: "job", jobId },
    });
  }

  const [fresh] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, locked.id));
  return {
    quote: fresh ?? locked,
    ref,
    jobId,
    converted,
    replaced: prev ? { id: prev.id, ref: prevRef } : null,
    invoice,
    taskId: task?.id ?? null,
    work: built,
    rework,
    poDrafts: drafts?.drafted ?? [],
  };
}
